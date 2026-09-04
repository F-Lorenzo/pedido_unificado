import { EventEmitter } from "events";
import handler from "../api/extract.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ FALLA ") + m); if (!c) fail++; };

function fakeReq(method, bodyChunks) {
  const req = new EventEmitter();
  req.method = method;
  setImmediate(() => {
    (bodyChunks || []).forEach((c) => req.emit("data", c));
    req.emit("end");
  });
  return req;
}
function fakeRes() {
  const res = { _status: 0, _json: null };
  res.status = (s) => { res._status = s; return res; };
  res.json = (j) => { res._json = j; return res; };
  return res;
}
function mockOpenAI(responder) {
  global.fetch = async () => responder();
}
const okResp = (content, finish = "stop") => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ finish_reason: finish, message: { content } }] })
});
const errResp = (status, body) => ({
  ok: false, status,
  headers: { get: () => null },
  text: async () => body
});

process.env.OPENAI_API_KEY = "sk-test";

// --- P2: version de prompts expuesta -----------------------------------
console.log("P2 — version de extraccion calculada del prompt");
const rGet = fakeRes();
await handler(fakeReq("GET"), rGet);
const v1 = rGet._json.promptVersion;
ok(rGet._status === 200 && /^[0-9a-f]{12}$/.test(v1), `GET devuelve promptVersion (${v1})`);
const rGet2 = fakeRes();
await handler(fakeReq("GET"), rGet2);
ok(rGet2._json.promptVersion === v1, "es estable entre llamadas");

// --- P7: UTF-8 partido entre chunks ------------------------------------
console.log("\nP7 — acentos partidos en el borde de dos chunks");
mockOpenAI(() => okResp(JSON.stringify({ cliente: "x", items: [] })));
const texto = "PEDIDO; Señor Ñandú — 3 limón";
const full = Buffer.from(JSON.stringify({ files: [{ name: "t", tipo: "texto", contenido: texto }] }), "utf8");
// cortamos justo adentro del multibyte de la "ñ" de Ñandú
const idx = full.indexOf(Buffer.from("Ñ", "utf8")) + 1;
const rUtf = fakeRes();
await handler(fakeReq("POST", [full.subarray(0, idx), full.subarray(idx)]), rUtf);
ok(rUtf._status === 200 && rUtf._json.orders.length === 1,
   "el body se decodifica bien aunque el chunk parta un caracter");

// --- Mensaje generico ante problema de cuenta --------------------------
console.log("\nMensaje ante problema de cuenta (sin revelar el saldo)");
mockOpenAI(() => errResp(429, JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } })));
const t0 = Date.now();
const rQuota = fakeRes();
await handler(fakeReq("POST", [Buffer.from(JSON.stringify({ files: [{ name: "a.pdf", tipo: "texto", contenido: "PEDIDO; x" }] }))]), rQuota);
const elapsed = Date.now() - t0;
const msg = rQuota._json.errors[0].error;
console.log("    mensaje:", JSON.stringify(msg));
ok(msg === "Error en el procesamiento del archivo. Se recomienda mirar el panel de administración.", "usa el texto pedido");
ok(!/saldo|quota|cuota|OpenAI|429/i.test(msg), "no menciona saldo, cuota ni el proveedor");
ok(elapsed < 2000, `falla rapido, sin reintentos (${elapsed}ms)`);

// --- P10: corte por max_tokens -----------------------------------------
console.log("\nP10 — respuesta cortada por el techo de tokens");
mockOpenAI(() => okResp('{"items":[{"produc', "length"));
const rLen = fakeRes();
await handler(fakeReq("POST", [Buffer.from(JSON.stringify({ files: [{ name: "b.pdf", tipo: "texto", contenido: "x" }] }))]), rLen);
ok(/demasiado largo/i.test(rLen._json.errors[0].error), "avisa que el pedido es muy largo, no 'no se pudo leer'");

// --- Camino feliz -------------------------------------------------------
console.log("\nCamino feliz");
mockOpenAI(() => okResp(JSON.stringify({ numeroOrden: "395", cliente: "Ana", items: [{ producto: "P", variante: "CITRUS", cantidad: 3 }], subtotal: 1000, total: 900, promociones: 100 })));
const rOk = fakeRes();
await handler(fakeReq("POST", [Buffer.from(JSON.stringify({ files: [{ name: "o.pdf", tipo: "texto", contenido: "x" }] }))]), rOk);
ok(rOk._json.orders[0].numeroOrden === "395" && rOk._json.orders[0].archivo === "o.pdf", "devuelve la orden con su archivo");
ok(rOk._json.promptVersion === v1, "el POST tambien informa la version");
ok(rOk._json.errors.length === 0, "sin errores");

process.exit(fail ? 1 : 0);
