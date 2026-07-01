// Serverless function (Vercel) — recibe PDFs en base64, extrae el texto
// localmente (pdf-parse) y usa DeepSeek V4 Pro (servido via NVIDIA NIM) para
// estructurarlo en JSON.
//
// La API key NUNCA se expone al navegador: vive solo aca, en el servidor,
// leida desde la variable de entorno NVIDIA_API_KEY.

import pdfParse from "pdf-parse";

const MODEL = "deepseek-ai/deepseek-v4-pro";
const API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const CONCURRENCY = 5; // ordenes procesadas en paralelo contra la API (permite tandas grandes, ej. 40 PDFs, sin ir una por una)

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

async function callDeepSeek(apiKey, text, attempt = 1) {
  const payload = {
    model: MODEL,
    messages: [
      { role: "user", content: PROMPT + text }
    ],
    temperature: 0,
    top_p: 0.95,
    max_tokens: 16384, // de sobra para el JSON de una orden; asi cada request corta lo antes posible
    chat_template_kwargs: { thinking: false },
    response_format: { type: "json_object" },
    stream: false
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
    // NVIDIA NIM devuelve 429/503 por sobrecarga, y a veces un 400 con
    // "DEGRADED function cannot be invoked" cuando la replica del modelo
    // esta temporalmente caida de su lado: en los tres casos conviene
    // reintentar en vez de descartar el PDF.
    const retryable = resp.status === 429 || resp.status === 503 || /DEGRADED/i.test(txt);
    if (retryable && attempt < 5) {
      const waitMs = Math.min(2000 * 2 ** (attempt - 1), 20000);
      await sleep(waitMs);
      return callDeepSeek(apiKey, text, attempt + 1);
    }
    throw new Error(`DeepSeek ${resp.status}: ${txt.slice(0, 500)}`);
  }

  return resp.json();
}

async function extractOne(apiKey, file) {
  const pdfBuffer = Buffer.from(file.dataBase64, "base64");
  const { text } = await pdfParse(pdfBuffer);

  const json = await callDeepSeek(apiKey, text);
  const content = json?.choices?.[0]?.message?.content || "";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // por las dudas, intento rescatar el primer bloque {...}
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("El modelo no devolvio JSON valido para " + file.name);
    parsed = JSON.parse(m[0]);
  }
  parsed.archivo = file.name;
  return parsed;
}

// Corre `worker` sobre `items` con hasta `limit` en simultaneo, sin depender
// de librerias externas (asi el pool de concurrencia procesa 40 PDFs en
// paralelo en vez de uno por uno).
async function runWithConcurrency(items, limit, worker) {
  let next = 0;
  async function runNext() {
    const i = next++;
    if (i >= items.length) return;
    await worker(items[i], i);
    return runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Usa POST" });
    return;
  }

  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Falta NVIDIA_API_KEY en el servidor. Cargala en Vercel -> Settings -> Environment Variables." });
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

  await runWithConcurrency(files, CONCURRENCY, async (f) => {
    try {
      const o = await extractOne(apiKey, f);
      orders.push(o);
    } catch (e) {
      errors.push({ archivo: f.name, error: String(e.message || e) });
    }
  });

  res.status(200).json({ orders, errors });
}
