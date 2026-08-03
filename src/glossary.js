// ============================================================================
//  GLOSSARY — plain-language definitions for the metric shorthand used across
//  the dashboard, in English / العربية / हिन्दी. Surfaced via <Term> on hover.
//  Keys are lowercase and match the shorthand shown in the UI.
// ============================================================================
export const GLOSSARY = {
  wow: {
    term: "WoW", full: "Week over Week",
    en: "Change vs the same day last week (7 days ago). Strips out the weekly pattern — a Friday is compared to a Friday.",
    ar: "التغير مقارنة بنفس اليوم من الأسبوع الماضي (قبل 7 أيام). يُقارن الجمعة بالجمعة لإزالة تأثير النمط الأسبوعي.",
    hi: "पिछले हफ़्ते के उसी दिन (7 दिन पहले) की तुलना में बदलाव। शुक्रवार की तुलना शुक्रवार से — साप्ताहिक पैटर्न हट जाता है।",
  },
  mom: {
    term: "MoM", full: "Month over Month",
    en: "Change vs the same period one month earlier. Shows the near-term trend.",
    ar: "التغير مقارنة بنفس الفترة قبل شهر واحد. يوضح الاتجاه على المدى القريب.",
    hi: "एक महीने पहले की समान अवधि की तुलना में बदलाव। नज़दीकी रुझान दिखाता है।",
  },
  yoy: {
    term: "YoY", full: "Year over Year",
    en: "Change vs the same period last year. Cancels out seasonality — Ramadan vs Ramadan, summer vs summer.",
    ar: "التغير مقارنة بنفس الفترة من العام الماضي. يلغي الموسمية — رمضان مقابل رمضان.",
    hi: "पिछले साल की समान अवधि की तुलना में बदलाव। मौसमी असर हट जाता है — रमज़ान बनाम रमज़ान।",
  },
  dod: {
    term: "DoD", full: "Day over Day",
    en: "Change vs the day before (yesterday). The most immediate trend signal.",
    ar: "التغير مقارنة باليوم السابق (أمس). أسرع مؤشر على الاتجاه.",
    hi: "एक दिन पहले (कल) की तुलना में बदलाव। सबसे तात्कालिक रुझान संकेत।",
  },
  aov: {
    term: "AOV", full: "Average Order Value",
    en: "Net sales divided by number of orders — the average spend per order.",
    ar: "صافي المبيعات مقسومًا على عدد الطلبات — متوسط الإنفاق لكل طلب.",
    hi: "कुल बिक्री को ऑर्डर की संख्या से भाग — प्रति ऑर्डर औसत खर्च।",
  },
  netsales: {
    term: "Net Sales", full: "Net Sales",
    en: "Sales after discounts and refunds are removed — the revenue actually earned.",
    ar: "المبيعات بعد خصم التخفيضات والمستردات — الإيراد الفعلي المحقق.",
    hi: "छूट और रिफ़ंड घटाने के बाद की बिक्री — वास्तविक अर्जित राजस्व।",
  },
  orders: {
    term: "Orders", full: "Order Count",
    en: "The number of orders (transactions) in the period, regardless of value.",
    ar: "عدد الطلبات (المعاملات) في الفترة بغض النظر عن قيمتها.",
    hi: "अवधि में ऑर्डर (लेन-देन) की संख्या, मूल्य चाहे जो हो।",
  },
  runrate: {
    term: "Runrate", full: "Run Rate",
    en: "The projected full-period total if the current pace continues to the end of the period.",
    ar: "الإجمالي المتوقع للفترة كاملة إذا استمر المعدل الحالي حتى نهايتها.",
    hi: "यदि मौजूदा गति अवधि के अंत तक जारी रहे तो अनुमानित पूर्ण-अवधि कुल।",
  },
  rrr: {
    term: "RRR", full: "Required Run Rate",
    en: "The daily sales still needed, on average, to hit the monthly target by month-end.",
    ar: "المبيعات اليومية المطلوبة في المتوسط لتحقيق الهدف الشهري بنهاية الشهر.",
    hi: "महीने के अंत तक मासिक लक्ष्य पाने के लिए औसतन ज़रूरी दैनिक बिक्री।",
  },
  mrr: {
    term: "MRR", full: "Month Run Rate",
    en: "The projected month-end total based on performance so far this month.",
    ar: "الإجمالي المتوقع بنهاية الشهر بناءً على الأداء حتى الآن هذا الشهر.",
    hi: "इस महीने अब तक के प्रदर्शन के आधार पर अनुमानित महीने-अंत कुल।",
  },
  drr: {
    term: "DRR", full: "Daily Run Rate",
    en: "The average sales per day so far in the period.",
    ar: "متوسط المبيعات اليومية حتى الآن في الفترة.",
    hi: "अवधि में अब तक की प्रति-दिन औसत बिक्री।",
  },
  mtd: {
    term: "MTD", full: "Month to Date",
    en: "The running total from the 1st of the month up to today.",
    ar: "الإجمالي التراكمي من أول الشهر حتى اليوم.",
    hi: "महीने की पहली तारीख से आज तक का चालू कुल।",
  },
  ytd: {
    term: "YTD", full: "Year to Date",
    en: "The running total from 1 January up to today.",
    ar: "الإجمالي التراكمي من 1 يناير حتى اليوم.",
    hi: "1 जनवरी से आज तक का चालू कुल।",
  },
  target: {
    term: "Target", full: "Target",
    en: "The planned sales goal for the period, used as the benchmark for variance.",
    ar: "هدف المبيعات المخطط للفترة، يُستخدم كمرجع لحساب الفارق.",
    hi: "अवधि के लिए नियोजित बिक्री लक्ष्य, विचलन का मानक।",
  },
  variance: {
    term: "Variance", full: "Variance",
    en: "The gap between actual and target, as a percentage. Positive means ahead of plan.",
    ar: "الفارق بين الفعلي والهدف كنسبة مئوية. الموجب يعني تجاوز الخطة.",
    hi: "वास्तविक और लक्ष्य के बीच का अंतर, प्रतिशत में। धनात्मक यानी योजना से आगे।",
  },
  penetration: {
    term: "Penetration", full: "Item Penetration",
    en: "The share of orders that included a given item — how widely it sells.",
    ar: "نسبة الطلبات التي تضمنت صنفًا معينًا — مدى انتشار بيعه.",
    hi: "किसी आइटम वाले ऑर्डर का हिस्सा — वह कितने व्यापक रूप से बिकता है।",
  },
  attach: {
    term: "Attach", full: "Attach Rate",
    en: "How often an add-on is bought alongside a main item.",
    ar: "معدل شراء صنف إضافي مع الصنف الرئيسي.",
    hi: "मुख्य आइटम के साथ ऐड-ऑन कितनी बार खरीदा जाता है।",
  },
  prep: {
    term: "Prep Time", full: "Preparation Time",
    en: "Average minutes from order received to order ready. Lower is better.",
    ar: "متوسط الدقائق من استلام الطلب حتى جاهزيته. الأقل أفضل.",
    hi: "ऑर्डर मिलने से तैयार होने तक औसत मिनट। कम बेहतर है।",
  },
  delivery: {
    term: "Delivery Time", full: "Delivery Time",
    en: "Average minutes from order ready to delivered to the customer. Lower is better.",
    ar: "متوسط الدقائق من جاهزية الطلب حتى تسليمه للعميل. الأقل أفضل.",
    hi: "ऑर्डर तैयार होने से ग्राहक तक पहुँचने तक औसत मिनट। कम बेहतर है।",
  },
};

export const glossaryLookup = (key) => GLOSSARY[String(key || "").toLowerCase().replace(/[^a-z]/g, "")] || null;
