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
  deviceScaleFactor: 1,
});

// 1) Windguru: captura de la tabla de pronóstico de cada spot.
for (const [name, id] of Object.entries(SPOTS)) {
  const key = `windguru_${name}`;
  try {
    const page = await ctx.newPage();
    await page.goto(`https://www.windguru.cz/${id}`, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(6000);
    const table = page.locator("#div_wgfcst1, .wgfcst").first();
    const file = path.join(OUT, `${key}.png`);
    if (await table.count()) await table.screenshot({ path: file });
    else await page.screenshot({ path: file, fullPage: false });
    await page.close();
    note(key, true);
  } catch (e) { note(key, false, e); }
}

// 2) Radar del SMN: guarda las imágenes que carga la página y una captura de respaldo.
try {
  const page = await ctx.newPage();
  const seen = new Map();
  page.on("response", async (r) => {
    try {
      const u = r.url();
      const ct = r.headers()["content-type"] || "";
      if (ct.startsWith("image/") && /radar|mosaic|zh|cmax/i.test(u)) {
        const buf = await r.body();
        if (buf.length > 20000) seen.set(u, { buf, ct });
      }
    } catch {}
  });
  await page.goto("https://www.smn.gob.ar/radar", { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(8000);
  await page.screenshot({ path: path.join(OUT, "radar_pagina.png"), fullPage: false });
  let i = 0;
  const urls = [];
  for (const [u, { buf, ct }] of seen) {
    const ext = ct.includes("png") ? "png" : ct.includes("gif") ? "gif" : "jpg";
    fs.writeFileSync(path.join(OUT, `radar_${i++}.${ext}`), buf);
    urls.push(u);
  }
  meta.radarUrls = urls;
  await page.close();
  note("radar", true);
} catch (e) { note("radar", false, e); }

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
