// Brand & channel identity — colours + monograms in ONE place.
// Every mark first tries a real logo file the user drops into /public/logos/…;
// if that 404s it falls back to a polished colour monogram (so nothing ever breaks).
//
// To use OFFICIAL artwork: drop a PNG (transparent background works best) into
//   public/logos/brands/<slug>.png     e.g. public/logos/brands/yelo-pizza.png
//   public/logos/channels/<slug>.png   e.g. public/logos/channels/talabat.png
// The slug is the name lower-cased with spaces/symbols turned into "-".
// It appears automatically on next load — no code change needed.

export const slug = (s) =>
  String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

// darken/lighten a #rrggbb by p (−255..255) for the monogram gradient
export const shade = (hex, p) => {
  const n = parseInt(String(hex).slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, v));
  const r = c((n >> 16) + p), g = c(((n >> 8) & 255) + p), b = c((n & 255) + p);
  return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
};

// company logo (shown for the "All Brands" scope)
export const COMPANY_LOGO = "/brands/SwishLogo.jpg";

// ---- delivery channels / order sources --------------------------------------
// `f` is the real logo file in /public/ordersource/. Colour drives the chips +
// chart series (Talabat orange, Keeta Meituan-yellow, Deliveroo teal, …).
export const CHANNEL_META = {
  "Talabat":   { c: "#FF5A00", ink: "#ffffff", ab: "ta", f: "/ordersource/talabat.png" },
  "Keeta":     { c: "#FFC800", ink: "#1A1A1A", ab: "K",  f: "/ordersource/keeta.webp" },
  "Deliveroo": { c: "#00CCBC", ink: "#ffffff", ab: "D",  f: "/ordersource/deliveroo.webp" },
  "Jahez":     { c: "#E11B22", ink: "#ffffff", ab: "J",  f: "/ordersource/jahez.webp" },
  "Snoonu":    { c: "#F5325B", ink: "#ffffff", ab: "S",  f: "/ordersource/snoonu.webp" },
  "Ordable":   { c: "#6C5CE7", ink: "#ffffff", ab: "O",  f: "/ordersource/ordable.webp" },
  "V-Throu":   { c: "#2D9CDB", ink: "#ffffff", ab: "V",  f: "/ordersource/v-thru.webp" },
  "In-store":  { c: "#475467", ink: "#ffffff", ab: "IS", f: "/ordersource/In-Store.webp" },
};

// ---- the company's own QSR brands (Kuwait) ----------------------------------
// `f` is the real logo file in /public/brands/. Colour is the monogram fallback
// tint + used where a brand colour is needed (treemap / scatter / bars).
export const BRAND_META = {
  "BBT":             { c: "#EF4A2B", ink: "#ffffff", ab: "BB", f: "/brands/LogoBBT.png" },          // red-orange (logo)
  "Chilli Pepper":   { c: "#8C5DB8", ink: "#ffffff", ab: "CP", f: "/brands/LogoChillyPepper.png" }, // purple (logo bg)
  "Just C":          { c: "#141414", ink: "#ffffff", ab: "JC", f: "/brands/LogoJustC.png" },        // black
  "Mishmash":        { c: "#3B2E7E", ink: "#ffffff", ab: "MM", f: "/brands/LogoMishmash.png" },     // deep indigo (logo font)
  "Pattie Pattie":   { c: "#1F2937", ink: "#ffffff", ab: "PP", f: "/brands/LogoPattiePattie.png" },
  "Shawarma Shakir": { c: "#B91C1C", ink: "#ffffff", ab: "SS", f: "/brands/LogoShakir.jpeg" },
  "Slice":           { c: "#EF4444", ink: "#ffffff", ab: "SL", f: "/brands/LogoSlice.png" },
  "Tabel":           { c: "#7C7A33", ink: "#ffffff", ab: "TB", f: "/brands/LogoTabel.png" },        // olive green (logo bg)
  "Yelo Pizza":      { c: "#F5B301", ink: "#111111", ab: "YP", f: "/brands/LogoYeloPizza.png" },    // yellow
  "ForeverMore":     { c: "#0E9384", ink: "#ffffff", ab: "FM", f: "/brands/LogoForeverMore.jpeg" },
};

// hashed fallback for any name we don't have metadata for
function fallbackMeta(name) {
  const hue = [...String(name)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  const ab = String(name).split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase() || "?";
  return { c: `hsl(${hue} 60% 46%)`, ink: "#ffffff", ab };
}

export const brandMeta = (name) => BRAND_META[name] || fallbackMeta(name);
export const channelMeta = (name) => CHANNEL_META[name] || fallbackMeta(name);
export const brandSrc = (name) => brandMeta(name).f || `/brands/${slug(name)}.png`;
export const channelSrc = (name) => channelMeta(name).f || `/ordersource/${slug(name)}.png`;
export const brandColorOf = (name) => brandMeta(name).c;
export const channelColorOf = (name) => channelMeta(name).c;
