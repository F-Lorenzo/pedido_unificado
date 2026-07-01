# 🏭 Pedido Unificado a Fábrica

Web para subir los PDFs de tus órdenes, unirlos en un **pedido único** (sumando por
producto + variante) y calcular la **facturación total**. Usa **DeepSeek V4 Pro**
(servido vía **NVIDIA NIM**) para leer los PDFs — podés subir hasta unos 40 de una
sola vez, se procesan en paralelo — y exporta el pedido a **PDF** y **CSV**.

---

## ¿Qué hace?

1. Arrastrás uno o varios PDFs de órdenes (formato "Detalles de la orden #...").
2. La IA lee cada PDF y extrae los ítems, variantes, cantidades y totales.
3. Suma todo: si la fragancia **CITRUS** aparece en 3 órdenes, te da la cantidad total.
4. Te muestra:
   - **Pedido único** para mandar a la fábrica (producto · variante · SKU · cantidad).
   - **Facturación bruta** (suma de subtotales) y total cobrado.
   - **Notas de pedido** marcadas aparte para que las revises a mano (pueden tener
     productos extra que NO se suman automáticamente, por seguridad).
5. Exportás el pedido en **PDF** o **CSV**.

---

## Paso 1 — Conseguir la API key de NVIDIA (DeepSeek V4 Pro)

1. Entrá a **https://build.nvidia.com** y creá una cuenta (o entrá con la que ya tengas).
2. Buscá el modelo **deepseek-ai/deepseek-v4-pro** y generá una API key ("Get API Key").
3. Copiá la clave (algo como `nvapi-...`). La vas a pegar en Vercel en el Paso 2.

> A diferencia de Groq, NVIDIA NIM no tiene capa gratuita permanente: es pago por uso
> (con crédito inicial en cuentas nuevas). Con el volumen de este proyecto el costo
> mensual es bajo, pero tené en cuenta que ya no es $0.

---

## Paso 2 — Subir a Vercel (gratis)

### Opción A — Desde la web de Vercel (la más fácil, sin instalar nada)

1. Creá una cuenta gratis en **https://vercel.com** (podés entrar con GitHub o email).
2. Subí esta carpeta a un repo de GitHub **o** usá "Deploy" arrastrando la carpeta.
   - Si usás GitHub: subí la carpeta `pedido-unificado` a un repositorio nuevo,
     después en Vercel → **Add New → Project** → importás ese repo.
3. Antes de terminar el deploy, en **Environment Variables** agregá:
   - **Name:** `NVIDIA_API_KEY`
   - **Value:** la clave que copiaste en el Paso 1
4. Clic en **Deploy**. En 1–2 minutos te da una URL pública (ej. `https://pedido-unificado.vercel.app`).
   ¡Esa es tu app, accesible desde cualquier lado!

### Opción B — Desde tu computadora (con la terminal)

```bash
npm i -g vercel        # instala el comando vercel (una sola vez)
cd pedido-unificado
vercel                 # seguí los pasos; te pide loguearte
vercel env add NVIDIA_API_KEY   # pegá tu clave cuando te la pida
vercel --prod          # publica la versión final
```

---

## Probar en tu compu antes de publicar (opcional)

```bash
cp .env.example .env.local      # y pegá tu NVIDIA_API_KEY dentro
npm i -g vercel
vercel dev                      # abre http://localhost:3000
```

---

## Estructura del proyecto

```
pedido-unificado/
├─ api/
│  └─ extract.js        ← backend: extrae texto del PDF y llama a DeepSeek/NVIDIA (acá vive la API key, segura)
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
- **Formato de los PDFs:** está afinado para tus órdenes "Detalles de la orden #...".
  Si cambian mucho de formato, avisame y ajusto el prompt en `api/extract.js`.
- **Variantes:** se separan por lo que va entre paréntesis en la descripción
  (CITRUS, PHANTOM, etc.). El mismo SKU en distintas variantes se trata por separado.
- **Notas del pedido:** cosas como "+ 8 esencias del pedido anterior" NO se suman solas
  (son texto libre y riesgoso). Aparecen en una sección aparte para que las sumes vos.
- **Facturación bruta** = suma de los *subtotales* (antes de promociones). También se
  muestra el total cobrado (después de promos).
- **Subida masiva (~40 PDFs de una):** ya no hay lotes fijos de 3. El frontend agrupa
  los archivos por tamaño (para no superar el límite de payload de Vercel, ~4.5MB por
  request) y el backend procesa hasta 5 órdenes en simultáneo contra la API. Si notás
  errores 429/503 con tandas muy grandes, bajá `CONCURRENCY` en `api/extract.js`.
- **Vercel `maxDuration: 300`** (en `vercel.json`) requiere plan **Pro** — en el plan
  Hobby las funciones se cortan a los 60s, lo cual puede no alcanzar para tandas
  grandes de PDFs.
