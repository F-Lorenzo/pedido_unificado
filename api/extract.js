// Serverless function (Vercel) — recibe PDFs en base64, extrae el texto
// localmente (pdf-parse) y usa GPT-4.1 Nano (OpenAI) para estructurarlo en JSON.
//
// La API key NUNCA se expone al navegador: vive solo aca, en el servidor,
// leida desde la variable de entorno OPENAI_API_KEY.

// Importamos lib/pdf-parse.js y NO el index.js del paquete: ese index tiene
// un "modo debug" (isDebugMode = !module.parent) que, al importarlo como ESM,
// se activa e intenta leer un PDF de prueba relativo al cwd -> ENOENT y la
// funcion entera se cae al arrancar. Entrando por lib/ salteamos ese codigo.
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { createHash } from "crypto";

// gpt-4.1-nano en vez de gpt-5-nano: cuesta un poco mas pero soporta
// temperature=0 (salida deterministica de verdad), a diferencia de la
// familia gpt-5 que fuerza temperature=1 y puede variar entre corridas
// con el mismo PDF (deletreo de variantes, cantidades, etc.).
const MODEL = "gpt-4.1-nano";
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
- Si un item pide una variante "surtida"/"surtido" (mezcla de fragancias sin especificar
  cual, en vez de una fragancia puntual), usa "SURTIDO" como variante (en MAYUSCULAS).
  NUNCA la omitas, NUNCA la mandes a "notas" ni la ignores: debe aparecer como item
  normal en la tabla final, igual que cualquier otra variante.
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
- Si una linea pide una variante "surtida"/"surtido"/"surtidos" (mezcla de fragancias
  sin especificar cual, ej "13 surtidas (no Saiba)"), usa "SURTIDO" como base de la
  variante (en MAYUSCULAS), agregando la aclaracion si la hay (ej "SURTIDO (NO SAIBA)").
  NUNCA la omitas, NUNCA la mandes a "notas": debe aparecer como item normal en la
  tabla final igual que cualquier otro aroma.
- Validacion: si la suma de las cantidades de una subcategoria NO coincide con el
  total declarado al principio para esa categoria, anotalo en "notas" en lenguaje
  simple (ej "Textiles: declarado 35, sumado 34, revisar a mano").
- No inventes items que no esten en el texto.
- Si un valor no esta, usa null.
- Devolve solo el JSON, nada mas.

TEXTO DEL PEDIDO:
`;

// Version de extraccion: hash del modelo + los dos prompts. El cliente la usa
// como parte de la clave de cache, asi que cualquier cambio de prompt invalida
// solo lo cacheado. Antes era una constante manual ("v1") que habia que
// acordarse de subir: si no, un prompt corregido seguia devolviendo para
// siempre los resultados viejos, sin ningun sintoma.
const PROMPT_VERSION = createHash("sha256")
  .update(MODEL + "\n" + PROMPT_PDF + "\n" + PROMPT_TEXTO)
  .digest("hex")
  .slice(0, 12);

function readBody(req) {
  return new Promise((resolve, reject) => {
    // Juntamos Buffers y recien al final decodificamos: concatenar como
    // string (data += chunk) parte los caracteres multibyte que caen justo
    // en el borde entre dos chunks y rompe los acentos (y con ellos el JSON).
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Un 429 de OpenAI puede ser dos cosas muy distintas:
//  - "te pasaste del limite por minuto": transitorio, conviene reintentar.
//  - problema de cuenta/cuota (insufficient_quota): permanente, reintentarlo
//    solo quema tiempo y termina igual en error.
// Por eso lo distinguimos: el permanente corta al toque.
// El mensaje al usuario es generico a proposito (no expone el estado de la
// cuenta); el detalle real queda en los logs de Vercel para el admin.
function esProblemaDeCuenta(rawText) {
  return /insufficient_quota|billing_hard_limit_reached|exceeded your current quota/i.test(rawText || "");
}

// Convierte errores tecnicos de la API en un mensaje que cualquiera pueda
// entender (se muestra tal cual en la web, sin JSON, codigos de status ni
// referencias a limites de capa gratuita).
function friendlyApiError(status, rawText) {
  if (esProblemaDeCuenta(rawText)) return "Error en el procesamiento del archivo. Se recomienda mirar el panel de administración.";
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

// Presupuesto total de espera por archivo. La funcion serverless tiene un
// techo de ejecucion (60s en el plan Hobby de Vercel; el maxDuration de 300
// de vercel.json solo aplica en Pro), asi que los reintentos no pueden
// comerse todo: dejamos margen para la llamada que si funcione.
const RETRY_BUDGET_MS = 25000;
const MAX_ATTEMPTS = 5;

// Techo de salida. Una orden real ronda los 600 tokens; sin tope, una
// respuesta desbocada puede correr hasta el maximo del modelo, comerse la
// funcion entera (60s en Hobby) y costar ~30 veces mas que un archivo normal.
const MAX_OUTPUT_TOKENS = 4000;

async function callOpenAI(apiKey, promptText, attempt = 1, spentMs = 0) {
  const payload = {
    model: MODEL,
    temperature: 0, // salida deterministica: mismo PDF, mismo resultado
    seed: 20260701, // fijo, mejora el "mejor esfuerzo" de determinismo de OpenAI (no es garantia total)
    max_tokens: MAX_OUTPUT_TOKENS,
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
    // Un problema de cuenta es permanente: reintentarlo no sirve de nada.
    const retryable = (resp.status === 429 && !esProblemaDeCuenta(txt)) || resp.status === 503;
    if (retryable && attempt < MAX_ATTEMPTS && spentMs < RETRY_BUDGET_MS) {
      // OpenAI suele mandar el header "retry-after"; si no viene, buscamos
      // una pista en el cuerpo, y si tampoco hay usamos backoff creciente.
      const restante = RETRY_BUDGET_MS - spentMs;
      const headerWait = parseFloat(resp.headers.get("retry-after") || "");
      const m = !isNaN(headerWait) ? null : txt.match(/try again in ([\d.]+)s/i);
      const pedido = !isNaN(headerWait)
        ? Math.ceil(headerWait * 1000) + 500
        : m
          ? Math.ceil(parseFloat(m[1]) * 1000) + 500
          : 3000 * 2 ** (attempt - 1);
      const waitMs = Math.min(pedido, restante);
      await sleep(waitMs);
      return callOpenAI(apiKey, promptText, attempt + 1, spentMs + waitMs);
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
  const choice = json?.choices?.[0];
  // Si se corto por el techo de tokens, el JSON viene incompleto: conviene
  // decirlo tal cual en vez de "no se pudo leer la respuesta".
  if (choice?.finish_reason === "length") {
    const err = new Error("El pedido es demasiado largo para procesarlo de una vez. Probá partirlo en dos.");
    err.technicalDetail = `finish_reason=length (max_tokens=${MAX_OUTPUT_TOKENS})`;
    throw err;
  }
  const content = choice?.message?.content || "";
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
  // El cliente pregunta la version de extraccion al cargar la pagina para
  // saber si su cache sigue siendo valida.
  if (req.method === "GET") {
    res.status(200).json({ promptVersion: PROMPT_VERSION });
    return;
  }

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
      errors.push({ archivo: f.name, error: msg });
    }
  }

  res.status(200).json({ orders, errors, promptVersion: PROMPT_VERSION });
}
