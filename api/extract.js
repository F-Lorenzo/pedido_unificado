// Serverless function (Vercel) — recibe PDFs en base64, extrae el texto
// localmente (pdf-parse) y usa GPT-5 Nano (el modelo mas barato de OpenAI)
// para estructurarlo en JSON.
//
// La API key NUNCA se expone al navegador: vive solo aca, en el servidor,
// leida desde la variable de entorno OPENAI_API_KEY.

import pdfParse from "pdf-parse";

const MODEL = "gpt-5-nano"; // el mas barato de OpenAI, de sobra para extraer JSON de un texto corto
const API_URL = "https://api.openai.com/v1/chat/completions";

// Prompt para ordenes formales extraidas de un PDF (formato "Detalles de la orden #...").
const PROMPT_PDF = `Sos un extractor de datos de ordenes de compra de una tienda.
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

// Prompt para pedidos informales escritos a mano o por WhatsApp (sin PDF,
// sin precios, con categorias de producto y listas de aromas/variantes).
const PROMPT_TEXTO = `Sos un extractor de datos de pedidos informales de una tienda de
aromatizantes (escritos a mano, por WhatsApp o similar, NO son un PDF formal).
Devolve UNICAMENTE un objeto JSON valido (sin texto extra, sin markdown, sin
backticks) con esta forma EXACTA:

{
  "numeroOrden": null,
  "fecha": "string o null",
  "cliente": "string o null",            // el nombre que aparece despues de 'PEDIDO;', 'PEDIDO:' o similar
  "items": [
    {
      "producto": "string",   // nombre de la categoria/linea de producto (ej "Perfumina Textil", "Contratipo", "Arolab", "Difusor de Varillas 125cc"), prolijo, con mayuscula inicial
      "variante": "string",   // nombre del aroma/fragancia, en MAYUSCULAS, sin numeros ni guiones sueltos
      "sku": "",
      "cantidad": number,
      "precioUnitario": null,
      "valorTotal": null
    }
  ],
  "subtotal": null,
  "promociones": null,
  "total": null,
  "notas": "string o null"   // usalo SOLO para avisar inconsistencias (ver regla de validacion abajo)
}

REGLAS IMPORTANTES:
- El texto suele empezar con "PEDIDO;" o "PEDIDO:" seguido del nombre del cliente.
- Puede haber un resumen de cantidades totales por tipo de producto al principio
  (ej "35 PERFUMINAS TEXTILES", "9 CONTRATIPO"). Es solo para validar, NO es un item.
- Despues viene el detalle real, a veces bajo un titulo "AROMAS:", organizado en
  subcategorias (ej "TEXTILES:", "Contratipo:", "AROLAB;", "DIFUSORES 125 cc:").
  Cada subcategoria define el "producto" de los items que siguen.
- Cada linea de detalle trae una cantidad y un nombre de aroma en formatos como
  "1 uva y frutos del bosque", "2-212 f", "3- invitus": extrae la cantidad (numero)
  y el nombre (el resto, sin el numero ni separadores como "-").
- Si una linea trae una aclaracion entre parentesis (ej "13 surtidas (no Saiba)"),
  conservala como parte del nombre de la variante.
- Validacion: si la suma de las cantidades de una subcategoria NO coincide con el
  total declarado al principio para esa categoria, anotalo en "notas" en lenguaje
  simple (ej "Textiles: declarado 35, sumado 34, revisar a mano").
- No inventes items que no esten en el texto.
- Si un valor no esta, usa null.
- Devolve solo el JSON, nada mas.

TEXTO DEL PEDIDO:
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
  err.technicalDetail = `OpenAI ${status}: ${rawText.slice(0, 500)}`;
  return err;
}

async function callOpenAI(apiKey, promptText, attempt = 1) {
  const payload = {
    model: MODEL,
    // gpt-5-nano no acepta "temperature" distinto del default (1): lo omitimos.
    reasoning_effort: "low", // esta tarea es extraccion simple, no hace falta razonar de mas (ahorra costo y tiempo)
    response_format: { type: "json_object" },
    messages: [
      { role: "user", content: promptText }
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
    if (retryable && attempt < 5) {
      // OpenAI suele mandar el header "retry-after"; si no viene, buscamos
      // una pista en el cuerpo, y si tampoco hay usamos backoff creciente.
      const headerWait = parseFloat(resp.headers.get("retry-after") || "");
      const m = !isNaN(headerWait) ? null : txt.match(/try again in ([\d.]+)s/i);
      const waitMs = !isNaN(headerWait)
        ? Math.min(Math.ceil(headerWait * 1000) + 500, 25000)
        : m
          ? Math.min(Math.ceil(parseFloat(m[1]) * 1000) + 500, 25000)
          : Math.min(4000 * 2 ** (attempt - 1), 20000);
      await sleep(waitMs);
      return callOpenAI(apiKey, promptText, attempt + 1);
    }
    throw apiError(resp.status, txt);
  }

  return resp.json();
}

async function extractOne(apiKey, item) {
  const esTexto = item.tipo === "texto";
  let promptText;

  if (esTexto) {
    const contenido = String(item.contenido || "").trim();
    if (!contenido) throw new Error("El pedido escrito está vacío.");
    promptText = PROMPT_TEXTO + contenido;
  } else {
    let text;
    try {
      const pdfBuffer = Buffer.from(item.dataBase64, "base64");
      ({ text } = await pdfParse(pdfBuffer));
    } catch (e) {
      const err = new Error("El archivo no parece ser un PDF válido o está dañado.");
      err.technicalDetail = String(e.message || e);
      throw err;
    }
    promptText = PROMPT_PDF + text;
  }

  const json = await callOpenAI(apiKey, promptText);
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
  parsed.archivo = item.name;
  return parsed;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Usa POST" });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Falta OPENAI_API_KEY en el servidor. Cargala en Vercel -> Settings -> Environment Variables." });
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
      const reintento = f.tipo === "texto" ? "Volvé a agregarlo manualmente." : "Volvé a subirlo manualmente.";
      errors.push({ archivo: f.name, error: `${msg} ${reintento}` });
    }
  }

  res.status(200).json({ orders, errors });
}
