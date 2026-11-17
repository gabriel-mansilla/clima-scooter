// Descarga capturas de Windguru, imágenes del radar del SMN y datos numéricos.
// Todo se guarda en data/latest para que Claude lo lea después.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const OUT = "data/latest";
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const meta = { capturedAtUTC: new Date().toISOString(), ok: {}, errors: {} };
const note = (k, ok, err) => { meta.ok[k] = ok; if (err) meta.errors[k] = String(err).slice(0, 300); };

const SPOTS = {
  buenos_aires: 261,
  quilmes: 114368,
  el_molino: 171334,
  peru_beach: 88345,
  obelisco: 509127,
};
const POINTS = {
  chacabuco: [-34.6355, -58.4372],
  intermedio: [-34.73, -58.415],
  burzaco: [-34.8286, -58.3925],
};

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
  locale: "es-AR",
  timezoneId: "America/Argentina/Buenos_Aires",
  deviceScaleFactor: 2,
});

// 1) Windguru: captura de la tabla de pronóstico de cada spot.
for (const [name, id] of Object.entries(SPOTS)) {
  const key = `windguru_${name}`;
  try {
    const page = await ctx.newPage();
    await page.goto(`https://www.windguru.cz/${id}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(12000);
    // La página tiene dos bloques: arriba el modelo "WG" (el que usás) y abajo GFS 13 km.
    // Se recorta el bloque de arriba: desde la fila de pestañas ("Compare") hasta la fila de modelos ("GFS-Wave").
    const file = path.join(OUT, `${key}.png`);
    await page.evaluate(() => window.scrollTo(0, 0));
    const top = await page.getByText("Compare", { exact: true }).first().boundingBox().catch(() => null);
    // La fila de modelos varía según el spot: se prueba "GFS-Wave", y si no está, el botón "GFS 13".
    let bottom = await page.getByText(/^GFS-Wave/).first().boundingBox().catch(() => null);
    if (!bottom) bottom = await page.getByText(/^GFS 13$/).first().boundingBox().catch(() => null);
    if (top && bottom && bottom.y > top.y) {
      await page.screenshot({
        path: file,
        clip: { x: 0, y: Math.max(0, top.y - 30), width: 720, height: bottom.y - top.y + 22 },
      });
      meta.windguruModelo = "WG (bloque superior)";
    } else {
      await page.screenshot({ path: file, fullPage: false });
      meta.windguruModelo = "pantalla completa (no se encontró el bloque WG)";
    }
    await page.close();
    note(key, true);
  } catch (e) { note(key, false, e); }
}

// 2) Radar del SMN: mosaico ZH MAX, un cuadro cada 10 minutos (hora UTC en el nombre).
// Se baja el más reciente disponible y los 5 anteriores (última hora) para calcular el movimiento.
try {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
  const urlFor = (d) => `https://estaticos.smn.gob.ar/vmsr/radar/COMP_ARG_ZH_CMAX_${stamp(d)}.png`;
  const headers = { "User-Agent": "Mozilla/5.0 (clima-scooter)", Referer: "https://www.smn.gob.ar/" };
  const fetchImg = async (d) => {
    const r = await fetch(urlFor(d), { headers });
    (meta.radarDiag ||= []).push(`${stamp(d)} -> HTTP ${r.status} ${r.headers.get("content-type") || ""}`);
    if (!r.ok || !(r.headers.get("content-type") || "").startsWith("image/")) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > 20000 ? buf : null;
  };
  let t = new Date(Math.floor(Date.now() / 600000) * 600000);
  let latest = null, buf0 = null;
  for (let i = 0; i < 18 && !buf0; i++) {
    const d = new Date(t.getTime() - i * 600000);
    buf0 = await fetchImg(d);
    if (buf0) latest = d;
  }
  if (!buf0) throw new Error("No se encontró ningún cuadro reciente del radar");
  const frames = [];
  fs.writeFileSync(path.join(OUT, "radar_00.png"), buf0);
  frames.push(stamp(latest));
  for (let k = 1; k <= 5; k++) {
    const d = new Date(latest.getTime() - k * 600000);
    const b = await fetchImg(d);
    if (b) { fs.writeFileSync(path.join(OUT, `radar_${pad(k)}.png`), b); frames.push(stamp(d)); }
  }
  meta.radarCuadrosUTC = frames; // el primero es el más reciente
  note("radar", true);
} catch (e) { note("radar", false, e); }

// 2b) Radar de terceros (RainViewer y Windy), centrado en el trayecto. El SMN bloquea a GitHub.
// Se sacan 3 capturas de cada uno con unos segundos de diferencia: las páginas animan los últimos cuadros
// y la hora que muestra la pantalla permite ordenarlos y calcular el movimiento.
const RADAR_SITES = {
  rainviewer: "https://www.rainviewer.com/map.html?loc=-34.73,-58.415,7&layer=radar",
  windy: "https://www.windy.com/-Weather-radar-radar?radar,-34.73,-58.415,7",
};
meta.radarTerceros = {};
const rctx = await browser.newContext({
  viewport: { width: 1200, height: 900 },
  locale: "es-AR",
  timezoneId: "America/Argentina/Buenos_Aires",
  deviceScaleFactor: 1,
});
for (const [site, url] of Object.entries(RADAR_SITES)) {
  const key = `radar_${site}`;
  try {
    const page = await rctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(10000);
    // Cierra avisos de cookies si aparecen (mejor esfuerzo).
    for (const label of [/aceptar/i, /accept/i, /agree/i, /got it/i, /entendido/i]) {
      try { await page.getByRole("button", { name: label }).first().click({ timeout: 1500 }); break; } catch {}
    }
    await page.waitForTimeout(5000);
    const times = [];
    for (let i = 0; i < 3; i++) {
      await page.screenshot({ path: path.join(OUT, `${key}_${i}.png`) });
      times.push(new Date().toISOString());
      await page.waitForTimeout(4000);
    }
    meta.radarTerceros[site] = { url, capturasUTC: times };
    await page.close();
    note(key, true);
  } catch (e) { note(key, false, e); }
}

await browser.close();

// 3) Open-Meteo: modelos ICON, GFS y ECMWF en tres puntos del trayecto.
for (const [name, [lat, lon]] of Object.entries(POINTS)) {
  const key = `openmeteo_${name}`;
  try {
    const url = "https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
      latitude: lat, longitude: lon,
      hourly: "precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m,cape",
      models: "icon_seamless,gfs_seamless,ecmwf_ifs025",
      timezone: "America/Argentina/Buenos_Aires",
      forecast_days: "3",
    });
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    fs.writeFileSync(path.join(OUT, `${key}.json`), JSON.stringify(await r.json()));
    note(key, true);
  } catch (e) { note(key, false, e); }
}

// 4) Avisos oficiales del SMN.
try {
  const r = await fetch("https://ws.smn.gob.ar/alerts/type/AL", { headers: { "User-Agent": "clima-scooter" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  fs.writeFileSync(path.join(OUT, "smn_avisos.json"), await r.text());
  note("smn_avisos", true);
} catch (e) { note("smn_avisos", false, e); }

fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta, null, 2));
