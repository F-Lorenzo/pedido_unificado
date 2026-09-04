// Logica de unificacion: parseo de importes, facturacion e identidad de orden.
import { createRequire } from "module";
const A = createRequire(import.meta.url)("../public/aggregate.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ FALLA ") + m); if (!c) fail++; };

console.log("num() — importes en formato argentino");
ok(A.num("2.500,00") === 2500, 'num("2.500,00") = 2500');
ok(A.num("331.000,00") === 331000, 'num("331.000,00") = 331000');
// El punto sin coma es ambiguo; en importes argentinos son miles.
ok(A.num("331.000") === 331000, 'num("331.000") = 331000, no 331');
ok(A.num("1.234") === 1234, 'num("1.234") = 1234');
ok(A.num("1.234.567") === 1234567, 'num("1.234.567") = 1234567');
ok(A.num("-1.234") === -1234, "negativo con separador de miles");
// ...pero un decimal de verdad no se puede romper.
ok(A.num("2500.50") === 2500.5, 'num("2500.50") = 2500.50');
ok(A.num(331000) === 331000, "los numeros pasan derecho");
ok(A.num(null) === 0 && A.num(undefined) === 0 && A.num("") === 0, "vacios valen 0");
ok(A.num("$ 12.345,67") === 12345.67, "tolera el simbolo de peso y espacios");

console.log("\naggregate() — facturacion");
const conPromos = A.aggregate([{ numeroOrden: "1", subtotal: 1000, promociones: 200, total: 800, items: [] }]);
ok(conPromos.facturacionBruta === 1000 && conPromos.facturacionTotal === 800, "con total explicito");
const sinTotal = A.aggregate([{ numeroOrden: "2", subtotal: 1000, promociones: 200, total: null, items: [] }]);
ok(sinTotal.facturacionTotal === 800, "sin total, la neta se reconstruye (bruta - promos)");
ok(sinTotal.totalPromos === 200, "las promos se siguen reportando");

console.log("\naggregate() — pedidos sin precios");
const escrito = A.aggregate([{ numeroOrden: null, cliente: "Beto", subtotal: null, total: null, items: [{ producto: "P", variante: "UVA", cantidad: 5 }] }]);
ok(escrito.ordenes[0].sinPrecios === true, "un pedido escrito se marca sinPrecios");
ok(escrito.totalUnidades === 5, "sus unidades si cuentan");
ok(escrito.facturacionBruta === 0, "pero no suman a la facturacion");
ok(A.aggregate([{ numeroOrden: "9", subtotal: 100, total: 100, items: [] }]).ordenes[0].sinPrecios === false,
   "una orden con precios no se marca");

console.log("\naggregate() — suma por producto + variante");
const sumado = A.aggregate([
  { numeroOrden: "1", items: [{ producto: "Auto 10ml", variante: "CITRUS", sku: "P1", cantidad: 3 }] },
  { numeroOrden: "2", items: [{ producto: "Auto 10ml", variante: "CITRUS", sku: "P1", cantidad: 7 }] },
  { numeroOrden: "3", items: [{ producto: "Auto 10ml", variante: "PHANTOM", sku: "P1", cantidad: 2 }] }
]);
ok(sumado.lineas.length === 2, "mismo SKU en dos variantes = dos lineas");
ok(sumado.lineas.find((l) => l.variante === "CITRUS").cantidad === 10, "CITRUS suma 3 + 7 = 10");
ok(sumado.totalUnidades === 12, "12 unidades en total");

console.log("\nordenId() — identidad para no sumar dos veces la misma orden");
ok(A.ordenId({ numeroOrden: "395" }) === "orden:395", "por numero de orden");
ok(A.ordenId({ numeroOrden: " 395 " }) === A.ordenId({ numeroOrden: "395" }), "tolera espacios");
ok(A.ordenId({ numeroOrden: null, __hash: "abc" }) === "hash:abc", "sin numero, por hash del contenido");
ok(A.ordenId({ numeroOrden: "(s/n)", __hash: "x" }) === "hash:x", '"(s/n)" no cuenta como numero');
ok(A.ordenId({ numeroOrden: null }) === null, "sin nada identificable devuelve null (no se dedupea)");
ok(A.ordenId(null) === null, "tolera null");

process.exit(fail ? 1 : 0);
