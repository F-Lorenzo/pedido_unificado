// Ejecuta el script real de public/index.html contra un DOM minimo, para
// probar procesar(): dedupe de ordenes y limpieza de errores viejos.
import { readFileSync } from "fs";
import { createRequire } from "module";
import vm from "vm";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");

const require = createRequire(import.meta.url);
let fail = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ FALLA ") + m); if (!c) fail++; };

// --- DOM minimo ---------------------------------------------------------
const mkEl = () => {
  const el = {
    innerHTML: "", textContent: "", value: "", disabled: false, style: {},
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener() {}, appendChild() {}, click() {},
    querySelector: () => mkEl()
  };
  return el;
};
const els = new Map();
globalThis.document = {
  querySelector: (s) => { if (!els.has(s)) els.set(s, mkEl()); return els.get(s); },
  createElement: () => mkEl()
};
globalThis.window = globalThis;
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};
globalThis.performance = { now: () => Date.now() };
globalThis.PedidoAgg = require("../public/aggregate.js");

// --- fetch mockeado -----------------------------------------------------
let postResponder = () => ({ orders: [], errors: [], promptVersion: "v-test" });
let posts = 0;
globalThis.fetch = async (url, opts) => {
  const body = !opts || opts.method === "GET"
    ? { promptVersion: "v-test" }
    : (posts++, postResponder());
  const raw = JSON.stringify(body);
  return { ok: true, status: 200, text: async () => raw, json: async () => JSON.parse(raw) };
};

// --- cargar el script de la pagina --------------------------------------
const html = readFileSync(join(raiz, "public/index.html"), "utf8");
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];
vm.runInThisContext(code);
const read = (expr) => vm.runInThisContext(expr);
const set = (expr) => vm.runInThisContext(expr);

const ordenAna = { numeroOrden: "395", cliente: "Ana", subtotal: 1000, total: 1000,
  items: [{ producto: "Aromatizante", variante: "CITRUS", sku: "P25", cantidad: 10 }] };
// OJO: el contenido define la clave de cache. Para probar el dedupe hay que
// variarlo a proposito, si no la cache (correctamente) reusa la extraccion
// anterior y nunca se llega a llamar al backend.
const encolar = (nombre, contenido) =>
  set(`selected = [{name:${JSON.stringify(nombre)}, kind:"texto", contenido:${JSON.stringify(contenido || "PEDIDO; " + nombre)}}]`);
const limpiarCache = () => store.delete("pedidoUnificado.cache.v1");

// === P1: la misma orden no se suma dos veces ============================
console.log("P1 — dedupe de ordenes");
postResponder = () => ({ orders: [JSON.parse(JSON.stringify(ordenAna))], errors: [], promptVersion: "v-test" });

encolar("orden.pdf", "PEDIDO; Ana");
await read("procesar('nuevo')");
ok(read("allOrders.length") === 1, "primera pasada: 1 orden sumada");
ok(read("lastAgg.totalUnidades") === 10, "10 unidades");

// el usuario vuelve a soltar el MISMO pdf y le da a "Sumar"
encolar("orden.pdf", "PEDIDO; Ana");
await read("procesar('sumar')");
ok(read("allOrders.length") === 1, "segunda pasada del mismo PDF: sigue habiendo 1 orden");
ok(read("lastAgg.totalUnidades") === 10, "las unidades NO se duplicaron (siguen en 10)");

// un PDF distinto con OTRO numero de orden si se suma
postResponder = () => ({ orders: [{ ...ordenAna, numeroOrden: "396" }], errors: [], promptVersion: "v-test" });
encolar("otra.pdf", "PEDIDO; Carlos (otro pedido)");
await read("procesar('sumar')");
ok(read("allOrders.length") === 2, "una orden distinta (#396) si se suma");
ok(read("lastAgg.totalUnidades") === 20, "ahora si, 20 unidades");

// === Pedidos escritos (sin numero de orden) se dedupean por contenido ===
console.log("\nP1 — pedidos escritos, dedupe por contenido");
set("allOrders = []; allErrors = []"); limpiarCache();
postResponder = () => ({ orders: [{ numeroOrden: null, cliente: "Beto", items: [{ producto: "P", variante: "UVA", cantidad: 5 }] }], errors: [], promptVersion: "v-test" });
encolar("escrito", "PEDIDO; Beto");
await read("procesar('nuevo')");
encolar("escrito", "PEDIDO; Beto");
await read("procesar('sumar')");
ok(read("allOrders.length") === 1, "el mismo texto pegado dos veces cuenta una sola vez");

// dos textos distintos del mismo cliente si cuentan doble
set(`selected = [{name:"escrito2", kind:"texto", contenido:"PEDIDO; Beto (otra tanda)"}]`);
await read("procesar('sumar')");
ok(read("allOrders.length") === 2, "un texto distinto si se suma");

// === P5: el error viejo se limpia cuando el archivo despues anda ========
console.log("\nP5 — limpieza de errores ya resueltos");
set("allOrders = []; allErrors = []"); limpiarCache();
postResponder = () => ({ orders: [], errors: [{ archivo: "roto.pdf", error: "fallo" }], promptVersion: "v-test" });
encolar("roto.pdf", "PEDIDO; Roto");
await read("procesar('nuevo')");
ok(read("allErrors.length") === 1, "queda registrado el error");
ok(read("selected.length") === 1, "el archivo queda en la cola para reintentar");

postResponder = () => ({ orders: [JSON.parse(JSON.stringify(ordenAna))], errors: [], promptVersion: "v-test" });
await read("procesar('sumar')"); // reintento, esta vez anda
ok(read("allErrors.length") === 0, "al andar, el error viejo desaparece");
ok(read("allOrders.length") === 1, "y la orden queda sumada");
ok(read("selected.length") === 0, "la cola queda vacia");

// === P2: cambio de version de prompts invalida la cache =================
console.log("\nP2 — cambio de prompts invalida la cache");
ok(store.get("pedidoUnificado.cache.version") === "v-test", "la version quedo guardada");
const cacheAntes = store.get("pedidoUnificado.cache.v1");
ok(cacheAntes && Object.keys(JSON.parse(cacheAntes)).length > 0, "hay extracciones cacheadas");
set("aplicarVersion('v-nueva')");
ok(!store.get("pedidoUnificado.cache.v1"), "al cambiar la version, la cache se descarta");
set("aplicarVersion('v-nueva')");
ok(read("PROMPT_VERSION") === "v-nueva", "la misma version no vuelve a borrar nada");

process.exit(fail ? 1 : 0);
