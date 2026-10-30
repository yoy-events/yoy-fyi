// Text of the public landing page and the MCP setup guide in the four site languages.
// Ukrainian lives at / and /docs/mcp; the others at /<lang> and /<lang>/docs/mcp.
import type { Lang } from "./blog";

type Steps = string[];
export type PublicText = {
  title: string;
  h1: string;
  ogTitle: string;
  description: string;
  signIn: string;
  signInUnavailable: string;
  myLinks: string;
  featuresTitle: string;
  features: string[];
  aiTitle: string;
  ai: (mcp: string) => [string, string]; // text before and after the guide link
  guide: string;
  faqTitle: string;
  faq: [string, string][];
  footer: { blog: string; guide: string };
  docs: {
    title: string;
    description: string;
    h1: string;
    intro: (mcp: string) => string;
    claudeAi: Steps;
    chatgpt: Steps;
    claudeCodeAfter: string;
    cursorTitle: string;
    cursorIntro: string;
    keyFallback: string;
    keysPage: string;
    toolsTitle: string;
    tools: [string, string][];
    safetyTitle: string;
    safety: string;
    appsPage: string;
  };
};

const TOOL_NAMES = ["create_link", "create_links", "list_links", "get_link", "update_link", "disable_link", "get_qr", "get_click_timeseries", "get_click_breakdown", "get_conversions", "get_bio, update_bio", "whoami"];
const tools = (texts: string[]): [string, string][] => TOOL_NAMES.map((n, i) => [n, texts[i]!]);

export const PUBLIC_TEXT: Record<Lang, PublicText> = {
  uk: {
    title: "yoy.fyi",
    h1: "Короткі посилання та QR-коди",
    ogTitle: "yoy.fyi: короткі посилання й QR-коди",
    description: "Безкоштовні короткі посилання й QR-коди зі статистикою кліків. Працює на сайті, через API і прямо з ChatGPT чи Claude.",
    signIn: "Увійти через Google",
    signInUnavailable: "Вхід зараз недоступний.",
    myLinks: "Мої посилання",
    featuresTitle: "Що вміє",
    features: [
      "Коротке посилання yoy.fyi з власним кодом або випадковим, з назвою й тегами.",
      "QR-код для кожного посилання: PNG 1024 пікселі або SVG, свої кольори й підпис під кодом.",
      "Статистика кліків за днями, джерелами, UTM-мітками, країнами й пристроями.",
      "Готові варіанти посилання для Telegram, Instagram, Facebook і розсилки.",
      "Власне прев'ю, яке показують Telegram і Facebook, коли посилання надсилають у чат.",
      "Імпорт і експорт у CSV, сторінка link-in-bio на yoy.fyi/@ваша-назва.",
    ],
    aiTitle: "З ChatGPT і Claude",
    ai: (mcp) => [
      `Додайте ${mcp} як конектор у claude.ai чи ChatGPT і ввійдіть через Google. Тоді асистент створює справжні короткі посилання й QR-коди та відповідає, скільки було кліків.`,
      "",
    ],
    guide: "Покрокова інструкція",
    faqTitle: "Питання",
    faq: [
      ["Це безкоштовно?", "Так. Потрібен лише Google-акаунт для входу."],
      [
        "Чи можна створити коротке посилання через ChatGPT або Claude?",
        "Так. Підключіть yoy.fyi як конектор за адресою https://yoy.fyi/mcp, і асистент створюватиме справжні короткі посилання й QR-коди замість вигаданих адрес.",
      ],
      ["Скільки живе коротке посилання?", "Поки ви його не вимкнете або поки не мине термін дії, якщо ви його задали. Код вимкненого посилання не отримає ніхто інший."],
      ["Що зберігається про людей, які клікають?", "Час, сайт-джерело, UTM-мітки, браузер, пристрій і країна. IP-адреса не зберігається."],
    ],
    footer: { blog: "Блог", guide: "Підключення до AI" },
    docs: {
      title: "Підключення yoy.fyi до ChatGPT, Claude та інших",
      description: "Покрокові інструкції для claude.ai, ChatGPT, Claude Code і Cursor.",
      h1: "Підключення yoy.fyi до AI-асистентів",
      intro: (mcp) =>
        `yoy.fyi має MCP-сервер за адресою ${mcp}. Через нього асистент створює короткі посилання, показує QR-коди й статистику кліків. Посилання справжні й працюють одразу.`,
      claudeAi: [
        "Налаштування, розділ Connectors, Add custom connector.",
        "Адреса: https://yoy.fyi/mcp, далі Connect.",
        "Увійдіть через Google і на сторінці дозволів поставте галочку для створення посилань, якщо хочете, щоб Claude їх створював.",
        "У чаті ввімкніть yoy.fyi через кнопку «+».",
      ],
      chatgpt: [
        "Settings, Apps & Connectors, Advanced, увімкніть Developer mode.",
        "Створіть конектор з адресою https://yoy.fyi/mcp.",
        "Увійдіть через Google і дозвольте доступ. Доступність режиму залежить від тарифу ChatGPT.",
      ],
      claudeCodeAfter: "Потім у Claude Code виконайте /mcp, оберіть yoy-fyi й увійдіть через Google у браузері.",
      cursorTitle: "Cursor, VS Code та інші",
      cursorIntro: "Для Cursor додайте сервер у файл mcp.json, і під час першого підключення Cursor відкриє вхід через Google:",
      keyFallback: "Якщо програма не вміє входити через OAuth, створіть ключ на сторінці",
      keysPage: "API-ключі",
      toolsTitle: "Інструменти",
      tools: tools([
        "створює коротке посилання",
        "створює до 20 посилань за раз",
        "шукає посилання за текстом і тегом",
        "показує одне посилання",
        "змінює адресу, назву, теги, прев'ю чи термін дії",
        "вимикає посилання",
        "повертає QR-код картинкою",
        "кліки за годинами чи днями",
        "кліки за джерелом, UTM, країною, пристроєм",
        "реєстрації й оплати, які сервіс передав для посилань",
        "сторінка link-in-bio yoy.fyi/@назва",
        "до якого акаунта підключено",
      ]),
      safetyTitle: "Безпека",
      safety: "Асистент бачить лише ваші посилання й лише з тими дозволами, які ви дали. Усі підключення видно на сторінці",
      appsPage: "Підключені застосунки",
    },
  },
  en: {
    title: "yoy.fyi: free short links and QR codes",
    h1: "Short links and QR codes",
    ogTitle: "yoy.fyi: short links and QR codes",
    description: "Free short links and QR codes with click stats. Use it on the website, through the API, or straight from ChatGPT and Claude.",
    signIn: "Sign in with Google",
    signInUnavailable: "Sign-in is not available right now.",
    myLinks: "My links",
    featuresTitle: "What it does",
    features: [
      "A yoy.fyi short link with your own code or a random one, plus a title and tags.",
      "A QR code for every link: a 1024 pixel PNG or an SVG, with your colours and a caption under the code.",
      "Click stats by day, source, UTM tag, country and device.",
      "Ready-made variants of each link for Telegram, Instagram, Facebook and email.",
      "Your own preview card, shown by Telegram and Facebook when the link is shared in a chat.",
      "CSV import and export, and a link-in-bio page at yoy.fyi/@your-name.",
    ],
    aiTitle: "With ChatGPT and Claude",
    ai: (mcp) => [
      `Add ${mcp} as a connector in claude.ai or ChatGPT and sign in with Google. The assistant then creates real short links and QR codes, and tells you how many clicks they got.`,
      "",
    ],
    guide: "Step-by-step guide",
    faqTitle: "Questions",
    faq: [
      ["Is it free?", "Yes. All you need is a Google account to sign in."],
      [
        "Can I create a short link from ChatGPT or Claude?",
        "Yes. Connect yoy.fyi as a connector at https://yoy.fyi/mcp and the assistant will create real short links and QR codes instead of made-up addresses.",
      ],
      ["How long does a short link last?", "Until you disable it, or until the expiry date if you set one. A disabled code is never given to anyone else."],
      ["What is stored about people who click?", "The time, the referring site, UTM tags, browser, device and country. The IP address is not stored."],
    ],
    footer: { blog: "Blog", guide: "Connect to AI" },
    docs: {
      title: "Connect yoy.fyi to ChatGPT, Claude and other assistants",
      description: "Step-by-step setup for claude.ai, ChatGPT, Claude Code and Cursor.",
      h1: "Connect yoy.fyi to AI assistants",
      intro: (mcp) =>
        `yoy.fyi has an MCP server at ${mcp}. Through it, an assistant creates short links and shows QR codes and click stats. The links are real and work right away.`,
      claudeAi: [
        "Settings, Connectors, Add custom connector.",
        "Address: https://yoy.fyi/mcp, then Connect.",
        "Sign in with Google. On the permissions page, tick link creation if you want Claude to create links.",
        "In a chat, turn yoy.fyi on from the + button.",
      ],
      chatgpt: [
        "Settings, Apps & Connectors, Advanced, turn on Developer mode.",
        "Create a connector with the address https://yoy.fyi/mcp.",
        "Sign in with Google and allow access. Developer mode depends on your ChatGPT plan.",
      ],
      claudeCodeAfter: "Then run /mcp in Claude Code, pick yoy-fyi and sign in with Google in the browser.",
      cursorTitle: "Cursor, VS Code and others",
      cursorIntro: "For Cursor, add the server to mcp.json. On first use, Cursor opens Google sign-in:",
      keyFallback: "If an app can't sign in with OAuth, create a key on the page",
      keysPage: "API keys",
      toolsTitle: "Tools",
      tools: tools([
        "creates a short link",
        "creates up to 20 links at once",
        "finds links by text and tag",
        "shows one link",
        "changes the target, title, tags, preview or expiry",
        "disables a link",
        "returns the QR code as an image",
        "clicks by hour or day",
        "clicks by source, UTM, country, device",
        "sign-ups and purchases the service reported for the links",
        "the link-in-bio page yoy.fyi/@name",
        "which account is connected",
      ]),
      safetyTitle: "Safety",
      safety: "The assistant sees only your links, and only with the permissions you granted. Every connection is listed on the page",
      appsPage: "Connected apps",
    },
  },
  es: {
    title: "yoy.fyi: enlaces cortos y códigos QR gratis",
    h1: "Enlaces cortos y códigos QR",
    ogTitle: "yoy.fyi: enlaces cortos y códigos QR",
    description: "Enlaces cortos y códigos QR gratis con estadísticas de clics. Desde la web, por API o directamente desde ChatGPT y Claude.",
    signIn: "Entrar con Google",
    signInUnavailable: "El inicio de sesión no está disponible ahora.",
    myLinks: "Mis enlaces",
    featuresTitle: "Qué hace",
    features: [
      "Un enlace corto de yoy.fyi con tu propio código o uno aleatorio, con título y etiquetas.",
      "Un código QR para cada enlace: PNG de 1024 píxeles o SVG, con tus colores y un texto debajo.",
      "Estadísticas de clics por día, origen, etiqueta UTM, país y dispositivo.",
      "Variantes listas de cada enlace para Telegram, Instagram, Facebook y email.",
      "Tu propia tarjeta de vista previa, la que muestran Telegram y Facebook al compartir el enlace.",
      "Importación y exportación en CSV, y una página link-in-bio en yoy.fyi/@tu-nombre.",
    ],
    aiTitle: "Con ChatGPT y Claude",
    ai: (mcp) => [
      `Añade ${mcp} como conector en claude.ai o ChatGPT y entra con Google. El asistente crea enlaces cortos y códigos QR reales, y te dice cuántos clics tuvieron.`,
      "",
    ],
    guide: "Guía paso a paso",
    faqTitle: "Preguntas",
    faq: [
      ["¿Es gratis?", "Sí. Solo necesitas una cuenta de Google para entrar."],
      [
        "¿Puedo crear un enlace corto desde ChatGPT o Claude?",
        "Sí. Conecta yoy.fyi como conector en https://yoy.fyi/mcp y el asistente creará enlaces cortos y códigos QR reales en lugar de direcciones inventadas.",
      ],
      ["¿Cuánto dura un enlace corto?", "Hasta que lo desactives, o hasta la fecha de caducidad si la pusiste. Un código desactivado nunca se da a otra persona."],
      ["¿Qué se guarda de quien hace clic?", "La hora, el sitio de origen, las etiquetas UTM, el navegador, el dispositivo y el país. La dirección IP no se guarda."],
    ],
    footer: { blog: "Blog", guide: "Conectar con IA" },
    docs: {
      title: "Conectar yoy.fyi a ChatGPT, Claude y otros asistentes",
      description: "Configuración paso a paso para claude.ai, ChatGPT, Claude Code y Cursor.",
      h1: "Conectar yoy.fyi a asistentes de IA",
      intro: (mcp) =>
        `yoy.fyi tiene un servidor MCP en ${mcp}. Con él, un asistente crea enlaces cortos y muestra códigos QR y estadísticas de clics. Los enlaces son reales y funcionan al instante.`,
      claudeAi: [
        "Configuración, Connectors, Add custom connector.",
        "Dirección: https://yoy.fyi/mcp, luego Connect.",
        "Entra con Google. En la página de permisos, marca la creación de enlaces si quieres que Claude los cree.",
        "En un chat, activa yoy.fyi desde el botón +.",
      ],
      chatgpt: [
        "Settings, Apps & Connectors, Advanced, activa Developer mode.",
        "Crea un conector con la dirección https://yoy.fyi/mcp.",
        "Entra con Google y permite el acceso. El modo desarrollador depende de tu plan de ChatGPT.",
      ],
      claudeCodeAfter: "Después ejecuta /mcp en Claude Code, elige yoy-fyi y entra con Google en el navegador.",
      cursorTitle: "Cursor, VS Code y otros",
      cursorIntro: "En Cursor, añade el servidor a mcp.json. La primera vez, Cursor abre el inicio de sesión de Google:",
      keyFallback: "Si una aplicación no sabe entrar con OAuth, crea una clave en la página",
      keysPage: "claves de API",
      toolsTitle: "Herramientas",
      tools: tools([
        "crea un enlace corto",
        "crea hasta 20 enlaces a la vez",
        "busca enlaces por texto y etiqueta",
        "muestra un enlace",
        "cambia el destino, el título, las etiquetas, la vista previa o la caducidad",
        "desactiva un enlace",
        "devuelve el código QR como imagen",
        "clics por hora o por día",
        "clics por origen, UTM, país, dispositivo",
        "registros y compras que el servicio informó para los enlaces",
        "la página link-in-bio yoy.fyi/@nombre",
        "qué cuenta está conectada",
      ]),
      safetyTitle: "Seguridad",
      safety: "El asistente solo ve tus enlaces, y solo con los permisos que diste. Todas las conexiones aparecen en la página",
      appsPage: "aplicaciones conectadas",
    },
  },
  fr: {
    title: "yoy.fyi : liens courts et codes QR gratuits",
    h1: "Liens courts et codes QR",
    ogTitle: "yoy.fyi : liens courts et codes QR",
    description: "Liens courts et codes QR gratuits avec statistiques de clics. Sur le site, par API ou directement depuis ChatGPT et Claude.",
    signIn: "Se connecter avec Google",
    signInUnavailable: "La connexion n'est pas disponible pour le moment.",
    myLinks: "Mes liens",
    featuresTitle: "Ce que ça fait",
    features: [
      "Un lien court yoy.fyi avec votre propre code ou un code aléatoire, un titre et des tags.",
      "Un code QR pour chaque lien : PNG de 1024 pixels ou SVG, avec vos couleurs et une légende sous le code.",
      "Statistiques de clics par jour, source, balise UTM, pays et appareil.",
      "Des variantes prêtes de chaque lien pour Telegram, Instagram, Facebook et l'e-mail.",
      "Votre propre carte d'aperçu, affichée par Telegram et Facebook quand le lien est partagé.",
      "Import et export CSV, et une page link-in-bio sur yoy.fyi/@votre-nom.",
    ],
    aiTitle: "Avec ChatGPT et Claude",
    ai: (mcp) => [
      `Ajoutez ${mcp} comme connecteur dans claude.ai ou ChatGPT et connectez-vous avec Google. L'assistant crée alors de vrais liens courts et codes QR, et vous dit combien de clics ils ont reçus.`,
      "",
    ],
    guide: "Guide pas à pas",
    faqTitle: "Questions",
    faq: [
      ["C'est gratuit ?", "Oui. Il suffit d'un compte Google pour se connecter."],
      [
        "Peut-on créer un lien court depuis ChatGPT ou Claude ?",
        "Oui. Connectez yoy.fyi comme connecteur à l'adresse https://yoy.fyi/mcp et l'assistant créera de vrais liens courts et codes QR au lieu d'adresses inventées.",
      ],
      ["Combien de temps dure un lien court ?", "Jusqu'à ce que vous le désactiviez, ou jusqu'à sa date d'expiration si vous en avez fixé une. Un code désactivé n'est jamais donné à quelqu'un d'autre."],
      ["Que garde-t-on des personnes qui cliquent ?", "L'heure, le site d'origine, les balises UTM, le navigateur, l'appareil et le pays. L'adresse IP n'est pas conservée."],
    ],
    footer: { blog: "Blog", guide: "Connecter à l'IA" },
    docs: {
      title: "Connecter yoy.fyi à ChatGPT, Claude et d'autres assistants",
      description: "Configuration pas à pas pour claude.ai, ChatGPT, Claude Code et Cursor.",
      h1: "Connecter yoy.fyi aux assistants IA",
      intro: (mcp) =>
        `yoy.fyi a un serveur MCP à l'adresse ${mcp}. Grâce à lui, un assistant crée des liens courts et affiche les codes QR et les statistiques de clics. Les liens sont réels et marchent tout de suite.`,
      claudeAi: [
        "Paramètres, Connectors, Add custom connector.",
        "Adresse : https://yoy.fyi/mcp, puis Connect.",
        "Connectez-vous avec Google. Sur la page des autorisations, cochez la création de liens si vous voulez que Claude en crée.",
        "Dans une conversation, activez yoy.fyi avec le bouton +.",
      ],
      chatgpt: [
        "Settings, Apps & Connectors, Advanced, activez Developer mode.",
        "Créez un connecteur avec l'adresse https://yoy.fyi/mcp.",
        "Connectez-vous avec Google et autorisez l'accès. Le mode développeur dépend de votre abonnement ChatGPT.",
      ],
      claudeCodeAfter: "Lancez ensuite /mcp dans Claude Code, choisissez yoy-fyi et connectez-vous avec Google dans le navigateur.",
      cursorTitle: "Cursor, VS Code et autres",
      cursorIntro: "Pour Cursor, ajoutez le serveur à mcp.json. À la première utilisation, Cursor ouvre la connexion Google :",
      keyFallback: "Si une application ne sait pas se connecter en OAuth, créez une clé sur la page",
      keysPage: "clés d'API",
      toolsTitle: "Outils",
      tools: tools([
        "crée un lien court",
        "crée jusqu'à 20 liens d'un coup",
        "cherche des liens par texte et par tag",
        "affiche un lien",
        "change la destination, le titre, les tags, l'aperçu ou l'expiration",
        "désactive un lien",
        "renvoie le code QR en image",
        "clics par heure ou par jour",
        "clics par source, UTM, pays, appareil",
        "inscriptions et achats signalés par le service pour les liens",
        "la page link-in-bio yoy.fyi/@nom",
        "quel compte est connecté",
      ]),
      safetyTitle: "Sécurité",
      safety: "L'assistant ne voit que vos liens, et seulement avec les autorisations accordées. Toutes les connexions sont listées sur la page",
      appsPage: "applications connectées",
    },
  },
};
