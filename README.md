# 🏭 Pedido Unificado a Fábrica

Web para subir los PDFs de tus órdenes **o pegar pedidos escritos** (WhatsApp, papel),
unirlos en un **pedido único** (sumando por producto + variante) y calcular la
**facturación total**. Usa **GPT-4.1 Nano** (OpenAI, muy barato y con salida
determinística) para leer todo — se procesa **de a uno**, mostrando un tiempo
estimado mientras corre — y exporta el pedido a **PDF** y **CSV**.

---

## ¿Qué hace?

1. Arrastrás uno o varios PDFs de órdenes (formato "Detalles de la orden #...") y/o
   pegás pedidos escritos informales (WhatsApp, papel, con formato tipo
   "PEDIDO; Nombre" + lista de aromas por categoría) en el cuadro de texto.
2. La IA lee cada uno y extrae los ítems, variantes y cantidades (y precios, si el
   PDF los trae).
3. Suma todo: si la fragancia **CITRUS** aparece en 3 órdenes, te da la cantidad total.
4. Te muestra:
   - **Pedido único** para mandar a la fábrica (producto · variante · SKU · cantidad).
   - **Facturación bruta** (suma de subtotales) y total cobrado.
   - **Notas de pedido** marcadas aparte para que las revises a mano (pueden tener
     productos extra que NO se suman automáticamente, por seguridad).
5. Exportás el pedido en **PDF** o **CSV**.

---

## Paso 1 — Conseguir la API key de OpenAI

1. Entrá a **https://platform.openai.com/api-keys** con tu cuenta (necesitás saldo
   cargado — aunque sean un par de dólares, GPT-4.1 Nano es muy barato).
2. Clic en **"Create new secret key"**.
3. Copiá la clave (empieza con `sk-...`). La vas a pegar en Vercel en el Paso 2.

> No es gratis, pero es muy barato: GPT-4.1 Nano cuesta $0.10 / 1M tokens de entrada
> y $0.40 / 1M de salida. Procesar 100 PDFs sale centavos de dólar. Al tener saldo
> cargado también tenés límites de uso mucho más altos que cualquier capa gratuita.
> Se eligió sobre GPT-5 Nano porque soporta `temperature=0`: con el mismo PDF da
> siempre el mismo resultado (GPT-5 Nano fuerza una temperatura no-determinística
> y podía dar cantidades o deletreos de variantes distintos entre corridas).

---

## Paso 2 — Subir a Vercel (gratis)

### Opción A — Desde la web de Vercel (la más fácil, sin instalar nada)

1. Creá una cuenta gratis en **https://vercel.com** (podés entrar con GitHub o email).
2. Subí esta carpeta a un repo de GitHub **o** usá "Deploy" arrastrando la carpeta.
   - Si usás GitHub: subí la carpeta `pedido-unificado` a un repositorio nuevo,
     después en Vercel → **Add New → Project** → importás ese repo.
3. Antes de terminar el deploy, en **Environment Variables** agregá:
   - **Name:** `OPENAI_API_KEY`
   - **Value:** la clave que copiaste en el Paso 1
4. Clic en **Deploy**. En 1–2 minutos te da una URL pública (ej. `https://pedido-unificado.vercel.app`).
   ¡Esa es tu app, accesible desde cualquier lado!

### Opción B — Desde tu computadora (con la terminal)

```bash
npm i -g vercel        # instala el comando vercel (una sola vez)
cd pedido-unificado
vercel                 # seguí los pasos; te pide loguearte
vercel env add OPENAI_API_KEY   # pegá tu clave cuando te la pida
vercel --prod          # publica la versión final
```

---

## Probar en tu compu antes de publicar (opcional)

```bash
cp .env.example .env.local      # y pegá tu OPENAI_API_KEY dentro
npm i -g vercel
vercel dev                      # abre http://localhost:3000
```

---

## Estructura del proyecto

```
pedido-unificado/
├─ api/
│  └─ extract.js        ← backend: extrae texto del PDF y llama a OpenAI (acá vive la API key, segura)
├─ public/
│  ├─ index.html        ← la web (chat, subida, tabla, exportar PDF/CSV)
│  └─ aggregate.js      ← lógica de unificación (suma por producto+variante)
├─ package.json
├─ vercel.json
├─ .env.example
└─ README.md
```

---

## Notas importantes

- **Tu API key está protegida:** vive solo en el servidor (`api/extract.js`), nunca
  llega al navegador. Nadie puede robarla viendo el código de la página.
- **El pedido acumulado se guarda solo en tu navegador** (`localStorage`, no en un
  servidor) por hasta **24hs** desde la última actividad. Si recargás la página sin
  querer, se recupera automáticamente al volver a abrirla. Pasadas las 24hs (o al
  usar <b>Vaciar pedido acumulado</b>) se borra solo. Ojo: solo se guardan las
  órdenes ya procesadas y los pedidos escritos en cola — los PDFs que subiste pero
  todavía no procesaste NO se guardan (son pesados para `localStorage`), así que si
  se recarga la página antes de darle a "Sumar"/"Armar pedido", hay que volver a
  soltarlos.
- **Formato de los PDFs:** está afinado para tus órdenes "Detalles de la orden #...".
  Si cambian mucho de formato, avisame y ajusto el prompt en `api/extract.js`.
- **Pedidos escritos:** pensado para el formato "PEDIDO; Nombre" + categorías
  (TEXTILES, CONTRATIPO, AROLAB, DIFUSORES 125cc, etc.) con líneas "cantidad + aroma".
  Si al principio del texto hay un total declarado por categoría (ej "35 PERFUMINAS
  TEXTILES") y no coincide con la suma de esa categoría, queda anotado en "Notas de
  pedido" para que lo revises a mano. Estos pedidos no tienen precios, así que no
  suman a la facturación (solo a las cantidades del pedido único).
- **Un pedido escrito no siempre se fusiona en la misma línea que un PDF:** el
  nombre del producto/aroma que escribe la IA a partir de un texto informal puede no
  coincidir exactamente con el nombre/código que trae un PDF oficial (por variantes de
  redacción o abreviaturas). Cuando coincide, se suma en la misma fila; cuando no,
  aparece como fila aparte en el pedido único — igual queda todo en una sola tabla
  para revisar. Si querés que ciertos textos siempre se mapeen a un producto/variante
  exacto, decime cuáles y agrego esa equivalencia al prompt.
- **Variantes:** se separan por lo que va entre paréntesis en la descripción
  (CITRUS, PHANTOM, etc.). El mismo SKU en distintas variantes se trata por separado.
- **Pedidos de "surtido":** si un cliente pide una variante "surtida"/"surtido"
  (mezcla sin especificar fragancia, en un PDF o en un pedido escrito), aparece en el
  pedido único como su propia línea con variante **SURTIDO** — no se omite ni se manda
  a notas, se cuenta como cualquier otro aroma.
- **Notas del pedido:** cosas como "+ 8 esencias del pedido anterior" NO se suman solas
  (son texto libre y riesgoso). Aparecen en una sección aparte para que las sumes vos.
- **Facturación bruta** = suma de los *subtotales* (antes de promociones). También se
  muestra el total cobrado (después de promos).
- **Procesamiento de a uno:** cada PDF se manda en su propio request, en orden,
  sin trabajo en paralelo, con una pausa corta de ~1.2s entre archivo y archivo
  (`PACING_DELAY_MS` en `public/index.html`) — con cuenta paga de OpenAI el
  límite es mucho más alto (500 solicitudes/minuto en Tier 1) que en las capas
  gratuitas que probamos antes, así que no hace falta ser tan conservador. Si
  igual se llega a saturar, el backend reintenta automáticamente (hasta 5
  intentos) respetando el tiempo de espera que indica la API. La web muestra
  un tiempo estimado restante (arranca en ~3s por PDF y se ajusta con el
  promedio real a medida que van terminando).
- **Si un PDF o pedido escrito falla:** no frena a los demás. Queda listado aparte en
  "⚠️ No se pudieron leer" con el motivo en lenguaje simple y neutro (sin
  exponer detalles internos como el proveedor de IA o sus límites), y solo
  hay que volver a agregarlo.
- **Vercel `maxDuration: 300`** (en `vercel.json`) requiere plan **Pro** — en el plan
  Hobby las funciones se cortan a los 60s. Con tandas grandes de PDFs procesados
  de a uno, esto puede no alcanzar; si te pasa, subí los PDFs en tandas más chicas.
