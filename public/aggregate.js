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
    if (s.indexOf(",") > -1) s = s.replace(/\./g, "").replace(",", ".");
    var v = parseFloat(s);
    return isNaN(v) ? 0 : v;
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
      ordenes.push({
        numeroOrden: o.numeroOrden || "(s/n)",
        cliente: o.cliente || "",
        fecha: o.fecha || "",
        archivo: o.archivo || "",
        subtotal: num(o.subtotal),
        total: num(o.total)
      });

      // facturacion bruta = suma de subtotales (antes de promos).
      // Si no hay subtotal, caemos al total.
      var sub = o.subtotal != null ? num(o.subtotal) : num(o.total);
      facturacionBruta += sub;
      facturacionTotal += num(o.total != null ? o.total : o.subtotal);
      totalPromos += num(o.promociones);

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

  var api = { aggregate: aggregate, formatARS: formatARS, itemKey: itemKey, num: num };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PedidoAgg = api;
})(typeof window !== "undefined" ? window : globalThis);
