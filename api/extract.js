// Serverless function (Vercel) — recibe PDFs en base64, extrae el texto
// localmente (pdf-parse) y usa Groq (capa gratuita) para estructurarlo en JSON.
//
// La API key NUNCA se expone al navegador: vive solo aca, en el servidor,
// leida desde la variable de entorno GROQ_API_KEY.

import pdfParse from "pdf-parse";

const MODEL = "llama-3.3-70b-versatile"; // gratis en Groq, buena calidad para extraccion JSON
const API_URL = "https://api.groq.com/openai/v1/chat/completions";

// Prompt que le explica al modelo el formato exacto de estos pedidos.
const PROMPT = `Sos un extractor de datos de ordenes de compra de una tienda.
Te paso el TEXTO de UNA orden (extraido de un PDF). Devolve UNICAMENTE un objeto
JSON valido (sin texto extra, sin markdown, sin backticks) con esta forma EXACTA:

{
  "numeroOrden": "string o null",        // ej "395" (de 'Detalles de la orden #395')
  "fecha": "string o null",              // ej "29/6/2026"
  "cliente": "string o null",            // nombre del cliente
  "items": [
    {
      "producto": "string",   // nombre base SIN la variante ni el SKU. Ej "Aromatizador para Auto 10ml"
      "variante": "string",   // lo que va entre parentesis. Ej "CITRUS". Si no hay, ""
      "sku": "string",        // ej "P2520580". Si no hay, ""
      "cantidad": number,     // unidades (entero)
      "precioUnitario": number, // numero sin simbolos. Ej 2500
      "valorTotal": number      // numero sin simbolos. Ej 25000
    }
  ],
  "subtotal": number or null,   // 'Subtotal' del resumen de pago (facturacion BRUTA, antes de promos)
  "promociones": number or null, // descuento total aplicado (numero positivo)
  "total": number or null,      // 'Total' final a pagar (despues de promos)
  "notas": "string o null"      // texto de 'Notas del pedido' tal cual, si existe
}

REGLAS IMPORTANTES:
- Los precios argentinos usan punto para miles y coma para decimales: "$2.500,00" = 2500. "$331.000,00" = 331000.
- Separa SIEMPRE la variante (lo que esta entre parentesis en la descripcion) del nombre base del producto.
- El mismo SKU puede repetirse para distintas variantes: tratalas como items distintos igual.
- No inventes items. Solo los que aparezcan en la tabla 'Detalle del pedido'.
- NO sumes a los items lo que diga en 'Notas del pedido'. Eso va solo en el campo "notas".
- Si un valor no esta, usa null (o "" para strings de item).
- Devolve solo el JSON, nada mas.

TEXTO DE LA ORDEN:
`;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Convierte errores tecnicos de la API en un mensaje que cualquiera pueda
// entender (se muestra tal cual en la web, sin JSON, codigos de status ni
// referencias a limites de capa gratuita).
function friendlyApiError(status, rawText) {
  if (status === 429) return "El motor de inteligencia artificial alcanzó su capacidad máxima momentánea.";
  if (status === 503) return "El servicio de IA no está disponible en este momento.";
  if (status === 401 || status === 403) return "No se pudo autenticar con el servicio de IA (revisar la API key configurada en Vercel).";
  if (status >= 500) return "El servicio de IA tuvo un error interno.";
  return "El servicio de IA no pudo procesar este archivo.";
}

function apiError(status, rawText) {
  const err = new Error(friendlyApiError(status, rawText));
  err.technicalDetail = `Groq ${status}: ${rawText.slice(0, 500)}`;
  return err;
}

async function callGroq(apiKey, text, attempt = 1) {
  const payload = {
    model: MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "user", content: PROMPT + text }
    ]
  };

  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const txt = await resp.text();
    const retryable = resp.status === 429 || resp.status === 503;
    if (retryable && attempt < 4) {
      // Groq indica en el propio mensaje cuanto hay que esperar
      // ("...try again in 1.234s"); si no viene, usamos backoff creciente.
      const m = txt.match(/try again in ([\d.]+)s/i);
      const waitMs = m
        ? Math.min(Math.ceil(parseFloat(m[1]) * 1000) + 500, 20000)
        : Math.min(3000 * 2 ** (attempt - 1), 15000);
      await sleep(waitMs);
      return callGroq(apiKey, text, attempt + 1);
    }
    throw apiError(resp.status, txt);
  }

  return resp.json();
}

async function extractOne(apiKey, file) {
  let text;
  try {
    const pdfBuffer = Buffer.from(file.dataBase64, "base64");
    ({ text } = await pdfParse(pdfBuffer));
  } catch (e) {
    const err = new Error("El archivo no parece ser un PDF válido o está dañado.");
    err.technicalDetail = String(e.message || e);
    throw err;
  }

  const json = await callGroq(apiKey, text);
  const content = json?.choices?.[0]?.message?.content || "";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // por las dudas, intento rescatar el primer bloque {...}
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) {
      const err = new Error("El servicio de IA no devolvió una respuesta que se pudiera leer para este archivo.");
      err.technicalDetail = "Respuesta sin JSON: " + content.slice(0, 300);
      throw err;
    }
    try {
      parsed = JSON.parse(m[0]);
    } catch (e2) {
      const err = new Error("El servicio de IA no devolvió una respuesta que se pudiera leer para este archivo.");
      err.technicalDetail = "JSON invalido: " + content.slice(0, 300);
      throw err;
    }
  }
  parsed.archivo = file.name;
  return parsed;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Usa POST" });
    return;
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Falta GROQ_API_KEY en el servidor. Cargala en Vercel -> Settings -> Environment Variables." });
    return;
  }

  let body;
  try { body = await readBody(req); }
  catch (e) { res.status(400).json({ error: "Body invalido" }); return; }

  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length === 0) {
    res.status(400).json({ error: "No se enviaron archivos" });
    return;
  }

  const orders = [];
  const errors = [];

  // De a uno, sin concurrencia: mas predecible y mas facil de leer para el
  // usuario que ver varios PDFs "colgados" en simultaneo.
  for (const f of files) {
    try {
      const o = await extractOne(apiKey, f);
      orders.push(o);
    } catch (e) {
      if (e.technicalDetail) console.error(`Error procesando ${f.name}: ${e.technicalDetail}`);
      const msg = e.message || "No se pudo procesar este archivo.";
      errors.push({ archivo: f.name, error: `${msg} Volvé a subirlo manualmente.` });
    }
  }

  res.status(200).json({ orders, errors });
}
