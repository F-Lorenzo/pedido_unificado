// Logica de unificacion. Funciona tanto en el navegador como en Node (para tests).
(function (root) {
  "use strict";

  function normKey(s) {
    return String(s || "")
      .toUpperCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  // Clave de agrupacion: producto + variante (+ sku como respaldo).
  function itemKey(it) {
    return normKey(it.producto) + " || " + normKey(it.variante) + " || " + normKey(it.sku);
  }

  function num(n) {
    if (typeof n === "number" && !isNaN(n)) return n;
    if (n == null) return 0;
    // por si viene como string "2.500,00"
    var s = String(n).replace(/[^0-9,.-]/g, "");
    if (s.indexOf(",") > -1) {
      // Formato argentino completo: punto = miles, coma = decimales.
      s = s.replace(/\./g, "").replace(",", ".");
    } else if (s.indexOf(".") > -1) {
      // Sin coma, el punto es ambiguo: "331.000" son 331 mil (separador de
      // miles argentino) pero "2500.50" son 2500 con centavos. Si TODOS los
      // grupos despues del primero tienen exactamente 3 digitos, son miles.
      var partes = s.split(".");
      var todosMiles = partes.slice(1).every(function (p) { return /^\d{3}$/.test(p); });
      if (todosMiles) s = partes.join("");
    }
    var v = parseFloat(s);
    return isNaN(v) ? 0 : v;
  }

  // Identidad estable de una orden, para no sumarla dos veces al acumulado.
  // El numero de orden es unico cuando existe; los pedidos escritos no tienen,
  // asi que caen al hash del contenido exacto que les puso el cliente.
  // Devuelve null si no hay con que identificarla (ahi no se dedupea).
  function ordenId(o) {
    if (!o) return null;
    var n = normKey(o.numeroOrden);
    if (n && n !== "(S/N)") return "orden:" + n;
    if (o.__hash) return "hash:" + o.__hash;
    return null;
  }

  // orders: array de objetos como los devuelve el backend.
  // Devuelve { lineas, totalUnidades, facturacionBruta, facturacionTotal, totalPromos, notas, ordenes }
  function aggregate(orders) {
    var map = {};
    var totalUnidades = 0;
    var facturacionBruta = 0;
    var facturacionTotal = 0;
    var totalPromos = 0;
    var notas = [];
    var ordenes = [];

    (orders || []).forEach(function (o) {
      // facturacion bruta = suma de subtotales (antes de promos).
      // Si no hay subtotal, caemos al total.
      var sub = o.subtotal != null ? num(o.subtotal) : num(o.total);
      var promos = num(o.promociones);
      // Si falta el total, lo reconstruimos: bruto menos promos. Usar el
      // subtotal pelado dejaba las promos sin descontar y la "facturacion
      // neta" salia igual a la bruta.
      var tot = o.total != null ? num(o.total) : sub - promos;
      // Los pedidos escritos no traen precios: se marcan para no mostrarlos
      // como "$0,00", que se lee como un error de lectura.
      var sinPrecios = o.subtotal == null && o.total == null;

      ordenes.push({
        numeroOrden: o.numeroOrden || "(s/n)",
        cliente: o.cliente || "",
        fecha: o.fecha || "",
        archivo: o.archivo || "",
        subtotal: sub,
        total: tot,
        sinPrecios: sinPrecios
      });

      facturacionBruta += sub;
      facturacionTotal += tot;
      totalPromos += promos;

      if (o.notas && String(o.notas).trim()) {
        notas.push({
          numeroOrden: o.numeroOrden || "(s/n)",
          cliente: o.cliente || "",
          texto: String(o.notas).trim()
        });
      }

      (o.items || []).forEach(function (it) {
        var k = itemKey(it);
        var qty = num(it.cantidad);
        totalUnidades += qty;
        if (!map[k]) {
          map[k] = {
            producto: it.producto || "",
            variante: it.variante || "",
            sku: it.sku || "",
            cantidad: 0,
            precioUnitario: num(it.precioUnitario),
            valorTotal: 0,
            ordenes: []
          };
        }
        map[k].cantidad += qty;
        map[k].valorTotal += num(it.valorTotal);
        if (num(it.precioUnitario) > 0) map[k].precioUnitario = num(it.precioUnitario);
        map[k].ordenes.push(o.numeroOrden || "(s/n)");
      });
    });

    var lineas = Object.keys(map).map(function (k) { return map[k]; });
    // orden: por producto, luego variante
    lineas.sort(function (a, b) {
      var p = a.producto.localeCompare(b.producto);
      return p !== 0 ? p : a.variante.localeCompare(b.variante);
    });

    return {
      lineas: lineas,
      totalUnidades: totalUnidades,
      facturacionBruta: facturacionBruta,
      facturacionTotal: facturacionTotal,
      totalPromos: totalPromos,
      notas: notas,
      ordenes: ordenes
    };
  }

  function formatARS(n) {
    return "$" + (Number(n) || 0).toLocaleString("es-AR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  var api = { aggregate: aggregate, formatARS: formatARS, itemKey: itemKey, num: num, ordenId: ordenId };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PedidoAgg = api;
})(typeof window !== "undefined" ? window : globalThis);
