// Text of the signed-in pages in the four site languages. Ukrainian is the default; a visitor's
// choice is kept in a cookie (see web.tsx). The API, the admin and the Telegram bot stay as they are.
import type { Lang } from "./blog";

type M = {
  nav: { keys: string; apps: string; bio: string; signOut: string; blog: string; privacy: string; terms: string; language: string };
  scopes: Record<"links:read" | "links:write" | "analytics:read" | "webhooks:manage", string>;
  status: Record<string, string>;
  fields: Record<string, string>;
  unknownField: (k: string) => string;
  codes: Record<string, string>;
  reasons: Record<string, string>;
  targetNotAllowed: string;
  previewImageNotAllowed: string;
  bio: {
    handle: string;
    title: string;
    description: string;
    maxLinks: (n: number) => string;
    ownLinks: string;
    taken: (url: string) => string;
  };
  qr: { fg: string; bg: string; contrast: string; caption: (n: number) => string; svgOnly: string };
  csvUnclosed: string;
  preview: { legend: string; title: string; description: string; image: string; imageHint: string };
  create: { paste: string; more: string; title: string; code: string; codeHint: string; tags: string; tagsHint: string; shorten: string };
  signInFirst: string;
  home: {
    title: string;
    ready: string;
    shortLink: string;
    copy: string;
    qrFor: (url: string) => string;
    downloadQr: string;
    stats: string;
    firstHint: string;
    importCsv: string;
    exportCsv: string;
    search: string;
    searchButton: string;
    tags: string;
    showAll: string;
    nothing: string;
    clicks7d: (n: number) => string;
    tooMany: string;
  };
  importPage: {
    title: string;
    h1: string;
    intro: [string, string, string, string]; // around the column names
    perFile: (n: number) => string;
    line: (n: number) => string;
    shortFromLine: (n: number) => string;
    file: string;
    orPaste: string;
    button: string;
    downloadAll: string;
    tooBig: string;
    tooMany: string;
    empty: string;
    needTarget: string;
    unknownCols: (cols: string) => string;
    noRows: string;
    maxRows: (n: number) => string;
  };
  link: {
    channels: string;
    channelsHint: string;
    shortFor: (name: string) => string;
    copyFor: (name: string) => string;
    qrStyle: string;
    codeColour: string;
    background: string;
    caption: string;
    captionHint: string;
    captionPlaceholder: string;
    apply: string;
    clicks30: (n: number) => string;
    visitors: (n: number) => string;
    downloadClicks: string;
    referrers: string;
    channelsRanking: string;
    countries: string;
    devices: string;
    edit: string;
    whereTo: string;
    expires: string;
    expiresHint: string;
    save: string;
    disable: string;
    enable: string;
    disabledByUs: (email: string) => string;
    cannotEnable: (why: string) => string;
    byYoy: string;
    notAllowed: (reason: string) => string;
  };
  keys: {
    title: string;
    intro: [string, string, string]; // before the API link, between, after the MCP address
    newShown: string;
    newKey: string;
    name: string;
    namePlaceholder: string;
    permissions: string;
    create: string;
    lastUsed: string;
    never: string;
    revoke: string;
    errName: string;
    errScopes: string;
    errMax: (n: number) => string;
  };
  bioPage: { title: string; intro: string; address: string; addressHint: string; heading: string; description: string; links: string; createFirst: string; save: string };
  telegram: { title: string; intro: [string, string]; connected: string; disconnect: string; connect: string };
  apps: {
    title: string;
    intro: [string, string];
    disconnectAll: string;
    connected: string;
    lastUsed: string;
    calls30: (n: number) => string;
    latest: (tools: string) => string;
    revoke: string;
    never: string;
  };
  privacy: { title: string; h1: string; sections: [string, string][]; contact: (email: string) => string };
  terms: { title: string; h1: string; paragraphs: string[]; contact: (email: string) => string };
};

export const MESSAGES: Record<Lang, M> = {
  uk: {
    nav: { keys: "API-ключі", apps: "Підключені застосунки", bio: "Сторінка bio", signOut: "Вийти", blog: "Блог", privacy: "Конфіденційність", terms: "Умови", language: "Мова" },
    scopes: {
      "links:read": "Читати посилання",
      "links:write": "Створювати, змінювати й вимикати посилання",
      "analytics:read": "Читати статистику кліків",
      "webhooks:manage": "Керувати вебхуками кліків",
    },
    status: { active: "активне", expired: "закінчилось", disabled: "вимкнене" },
    fields: {
      target_url: "Адреса (target_url): до 2048 символів",
      code: "Свій код (code): 1–64 символи A-Z a-z 0-9 _ -",
      title: "Назва (title): до 200 символів",
      tags: "Теги (tags): до 20 різних тегів з a-z 0-9 _ : . -",
      utm_defaults: "UTM (utm_defaults): некоректні значення",
      preview: "Прев'ю (preview): потрібна назва до 200 символів, опис до 500, картинка — адреса https",
      expires_at: "Діє до (expires_at): дата й час у майбутньому",
      pass_click_id: "pass_click_id: так або ні",
    },
    unknownField: (k) => `${k}: некоректне значення`,
    codes: {
      code_reserved: "Цей код зарезервований.",
      code_taken: "Цей код уже зайнятий.",
      link_disabled: "Вимкнене посилання не можна змінити.",
      idempotency_key_reused: "Повторний запит з іншими даними.",
    },
    reasons: {
      scheme: "потрібна адреса, що починається з http:// або https://",
      credentials: "адреса не може містити логін і пароль",
      too_long: "адреса задовга",
      own_host: "не можна скорочувати адреси yoy.fyi",
      private_address: "приватні й локальні адреси заборонені",
      unresolvable: "такого домену не знайдено",
      unsafe: "Google Safe Browsing вважає цю адресу небезпечною (unsafe)",
      port: "нестандартний порт заборонено",
    },
    targetNotAllowed: "Адреса не дозволена (not allowed)",
    previewImageNotAllowed: "Адреса картинки прев'ю не дозволена",
    bio: {
      handle: "Адреса (handle): 3–30 символів a-z 0-9 _ . -, починається з літери чи цифри.",
      title: "Заголовок (title): не більше 100 символів.",
      description: "Опис (description): не більше 300 символів.",
      maxLinks: (n) => `Не більше ${n} посилань.`,
      ownLinks: "Обирайте лише свої посилання (link_ids).",
      taken: (url) => `${url} уже зайнята (taken).`,
    },
    qr: {
      fg: "Колір коду (fg) має бути на кшталт #1a2b3c",
      bg: "Колір фону (bg) має бути на кшталт #ffffff",
      contrast: "Замалий контраст (contrast): потрібен темний код на світлому фоні",
      caption: (n) => `Підпис (caption) — не більше ${n} символів`,
      svgOnly: "Підпис доступний лише в SVG",
    },
    csvUnclosed: "У CSV не закрита лапка.",
    preview: { legend: "Прев'ю в Telegram, Facebook та інших застосунках", title: "Назва прев'ю", description: "Опис прев'ю", image: "Адреса картинки прев'ю", imageHint: "https, від 1200×630" },
    create: { paste: "Вставте довге посилання", more: "Більше параметрів", title: "Назва", code: "Свій код", codeHint: "yoy.fyi/ваш-код", tags: "Теги", tagsHint: "через кому", shorten: "Скоротити" },
    signInFirst: "Спершу увійдіть",
    home: {
      title: "Мої посилання",
      ready: "Коротке посилання готове",
      shortLink: "Коротке посилання",
      copy: "Копіювати",
      qrFor: (url) => `QR-код для ${url}`,
      downloadQr: "Завантажити QR:",
      stats: "Статистика",
      firstHint: "Створіть перше коротке посилання: вставте довгу адресу нижче й отримайте коротке посилання yoy.fyi з QR-кодом і статистикою кліків.",
      importCsv: "Імпорт із CSV",
      exportCsv: "Експорт у CSV",
      search: "Пошук посилань",
      searchButton: "Шукати",
      tags: "Теги:",
      showAll: "Показати всі",
      nothing: "Нічого не знайдено.",
      clicks7d: (n) => `кліків за 7 днів: ${n}`,
      tooMany: "Забагато нових посилань. Спробуйте за годину.",
    },
    importPage: {
      title: "Імпорт посилань",
      h1: "Імпорт посилань із CSV",
      intro: ["Перший рядок — назви колонок: ", " (обов'язкова), ", " і ", " (через кому, в лапках)."],
      perFile: (n) => `До ${n} посилань в одному файлі.`,
      line: (n) => `Рядок ${n}:`,
      shortFromLine: (n) => `Коротке посилання з рядка ${n}`,
      file: "CSV-файл",
      orPaste: "або вставте його сюди",
      button: "Імпортувати",
      downloadAll: "Завантажити всі посилання в CSV",
      tooBig: "CSV більший за 256 КБ.",
      tooMany: "Забагато імпортів. Спробуйте за годину.",
      empty: "CSV порожній.",
      needTarget: "У першому рядку має бути колонка target_url.",
      unknownCols: (cols) => `Невідомі колонки: ${cols}.`,
      noRows: "У CSV немає рядків після заголовка.",
      maxRows: (n) => `Не більше ${n} посилань за один імпорт.`,
    },
    link: {
      channels: "Посилання для каналів",
      channelsHint: "Те саме коротке посилання з UTM-мітками, щоб у статистиці було видно, звідки прийшли кліки.",
      shortFor: (name) => `Коротке посилання для ${name}`,
      copyFor: (name) => `Копіювати для ${name}`,
      qrStyle: "Кольори й підпис QR",
      codeColour: "Код",
      background: "Фон",
      caption: "Підпис під кодом",
      captionHint: "лише в SVG, до 40 символів",
      captionPlaceholder: "Скануй мене",
      apply: "Застосувати",
      clicks30: (n) => `Кліків за 30 днів: ${n}`,
      visitors: (n) => `(відвідувачів щонайбільше ${n})`,
      downloadClicks: "Завантажити кліки в CSV",
      referrers: "Джерела",
      channelsRanking: "Канали (utm_source)",
      countries: "Країни",
      devices: "Пристрої",
      edit: "Редагувати посилання",
      whereTo: "Куди веде",
      expires: "Діє до",
      expiresHint: "UTC, порожньо — безстроково",
      save: "Зберегти",
      disable: "Вимкнути посилання",
      enable: "Увімкнути посилання",
      disabledByUs: (email) => `Це посилання вимкнув yoy.fyi. Якщо це помилка, напишіть на ${email}.`,
      cannotEnable: (why) => `Це посилання не можна увімкнути: ${why}.`,
      byYoy: "його вимкнув yoy.fyi",
      notAllowed: (reason) => `адреса не дозволена: ${reason}`,
    },
    keys: {
      title: "API-ключі",
      intro: ["Ключ працює з ", " або MCP-сервером ", ". Ключі діють лише на ваші посилання."],
      newShown: "Ваш новий ключ, показуємо лише зараз:",
      newKey: "Новий ключ",
      name: "Назва",
      namePlaceholder: "мій застосунок",
      permissions: "Дозволи",
      create: "Створити ключ",
      lastUsed: "останнє використання",
      never: "ніколи",
      revoke: "Відкликати",
      errName: "Назва: 1–100 символів.",
      errScopes: "Оберіть хоча б один дозвіл зі списку.",
      errMax: (n) => `Можна мати не більше ${n} активних ключів. Спершу відкличте один.`,
    },
    bioPage: {
      title: "Сторінка bio",
      intro: "Одна сторінка з вашими посиланнями для bio в Instagram чи Telegram",
      address: "Адреса",
      addressHint: "3–30 символів a-z 0-9 _ . -",
      heading: "Заголовок",
      description: "Опис",
      links: "Посилання, нові спершу",
      createFirst: "Спершу створіть коротке посилання.",
      save: "Зберегти",
    },
    telegram: { title: "Telegram-бот", intro: ["Надішліть довге посилання боту ", " й отримайте коротке посилання yoy.fyi та його QR."], connected: "Підключено.", disconnect: "Відключити", connect: "Підключити Telegram" },
    apps: {
      title: "Підключені застосунки",
      intro: ["Щоб працювати з посиланнями з чату, додайте ", " як конектор у claude.ai чи ChatGPT і ввійдіть тим самим Google-акаунтом."],
      disconnectAll: "Відключити всі",
      connected: "підключено",
      lastUsed: "останнє використання",
      calls30: (n) => `викликів за 30 днів: ${n}`,
      latest: (t) => ` · останні: ${t}`,
      revoke: "Відкликати",
      never: "ніколи",
    },
    privacy: {
      title: "Конфіденційність",
      h1: "Конфіденційність на yoy.fyi",
      sections: [
        ["", "yoy.fyi створює короткі посилання й рахує кліки по них. Тут написано, що він зберігає і як довго."],
        [
          "Ваш акаунт",
          "Коли ви входите через Google, yoy.fyi отримує й зберігає id вашого Google-акаунта, адресу пошти та ім'я. Вони потрібні лише для входу й щоб показувати, чиї посилання чиї. Нічого іншого з вашого Google-акаунта yoy.fyi не читає.",
        ],
        [
          "Кліки по коротких посиланнях",
          "Для кожного кліку yoy.fyi зберігає час, сайт, з якого прийшли, UTM-мітки й рекламні параметри, браузер, операційну систему й тип пристрою, країну (визначену за IP-адресою, яка не зберігається) і хеш, що змінюється щодня, для підрахунку унікальних відвідувачів. Окремі кліки зберігаються 13 місяців, після цього лишаються лише денні підсумки.",
        ],
        [
          "Відвідування сайту",
          "На публічних сторінках (головна, блог, документація, сторінки bio) yoy.fyi рахує відвідування: сторінку, час і сайт, з якого прийшли. Без cookies, без IP-адреси й без даних браузера. Для пошукових і AI-ботів записується лише їхня назва. Ці дані зберігаються 13 місяців.",
        ],
        [
          "Кому це видно",
          "Статистику посилання бачить його власник. Якщо власник налаштував вебхук, туди надсилаються описані вище дані кліку (ніколи не IP-адреса). yoy.fyi нічого нікому не продає.",
        ],
      ],
      contact: (email) => `Питання чи запити на видалення: ${email}.`,
    },
    terms: {
      title: "Умови",
      h1: "Умови користування yoy.fyi",
      paragraphs: [
        "yoy.fyi надається як є, безкоштовно, без жодних гарантій доступності.",
        "Не створюйте посилань на фішинг, шкідливі програми, шахрайство, спам чи будь-що незаконне. Посилання й акаунти, що порушують це правило, вимикаються без попередження.",
        "Короткі посилання можуть бути вимкнені будь-коли; код вимкненого посилання ніколи не передається іншим.",
      ],
      contact: (email) => `Контакти: ${email}.`,
    },
  },
  en: {
    nav: { keys: "API keys", apps: "Connected apps", bio: "Bio page", signOut: "Sign out", blog: "Blog", privacy: "Privacy", terms: "Terms", language: "Language" },
    scopes: {
      "links:read": "Read links",
      "links:write": "Create, change and disable links",
      "analytics:read": "Read click stats",
      "webhooks:manage": "Manage click webhooks",
    },
    status: { active: "active", expired: "expired", disabled: "disabled" },
    fields: {
      target_url: "Address (target_url): up to 2048 characters",
      code: "Custom code (code): 1-64 characters A-Z a-z 0-9 _ -",
      title: "Title (title): up to 200 characters",
      tags: "Tags (tags): up to 20 different tags of a-z 0-9 _ : . -",
      utm_defaults: "UTM (utm_defaults): invalid values",
      preview: "Preview (preview): needs a title up to 200 characters, a description up to 500, and an https image address",
      expires_at: "Expires (expires_at): a date and time in the future",
      pass_click_id: "pass_click_id: yes or no",
    },
    unknownField: (k) => `${k}: invalid value`,
    codes: {
      code_reserved: "This code is reserved.",
      code_taken: "This code is already taken.",
      link_disabled: "A disabled link can't be changed.",
      idempotency_key_reused: "A repeated request with different data.",
    },
    reasons: {
      scheme: "the address must start with http:// or https://",
      credentials: "the address can't contain a username and password",
      too_long: "the address is too long",
      own_host: "yoy.fyi addresses can't be shortened",
      private_address: "private and local addresses are not allowed",
      unresolvable: "that domain doesn't exist",
      unsafe: "Google Safe Browsing lists this address as unsafe",
      port: "non-standard ports are not allowed",
    },
    targetNotAllowed: "The address is not allowed",
    previewImageNotAllowed: "The preview image address is not allowed",
    bio: {
      handle: "Address (handle): 3-30 characters of a-z 0-9 _ . -, starting with a letter or digit.",
      title: "Title (title): at most 100 characters.",
      description: "Description (description): at most 300 characters.",
      maxLinks: (n) => `At most ${n} links.`,
      ownLinks: "Choose only your own links (link_ids).",
      taken: (url) => `${url} is taken.`,
    },
    qr: {
      fg: "The code colour (fg) must look like #1a2b3c",
      bg: "The background colour (bg) must look like #ffffff",
      contrast: "Not enough contrast: use a dark code on a light background",
      caption: (n) => `The caption is at most ${n} characters`,
      svgOnly: "A caption is available in the SVG only",
    },
    csvUnclosed: "The CSV has an unclosed quote.",
    preview: { legend: "Preview in Telegram, Facebook and other apps", title: "Preview title", description: "Preview description", image: "Preview image address", imageHint: "https, 1200×630 or larger" },
    create: { paste: "Paste a long link", more: "More options", title: "Title", code: "Custom code", codeHint: "yoy.fyi/your-code", tags: "Tags", tagsHint: "comma-separated", shorten: "Shorten" },
    signInFirst: "Sign in first",
    home: {
      title: "My links",
      ready: "Your short link is ready",
      shortLink: "Short link",
      copy: "Copy",
      qrFor: (url) => `QR code for ${url}`,
      downloadQr: "Download QR:",
      stats: "Stats",
      firstHint: "Create your first short link: paste a long address below and get a short yoy.fyi link with a QR code and click stats.",
      importCsv: "Import from CSV",
      exportCsv: "Export to CSV",
      search: "Search links",
      searchButton: "Search",
      tags: "Tags:",
      showAll: "Show all",
      nothing: "Nothing found.",
      clicks7d: (n) => `${n} clicks in 7 days`,
      tooMany: "Too many new links. Try again in an hour.",
    },
    importPage: {
      title: "Import links",
      h1: "Import links from CSV",
      intro: ["The first line names the columns: ", " (required), ", " and ", " (comma-separated, in quotes)."],
      perFile: (n) => `Up to ${n} links per file.`,
      line: (n) => `Line ${n}:`,
      shortFromLine: (n) => `Short link from line ${n}`,
      file: "CSV file",
      orPaste: "or paste it here",
      button: "Import",
      downloadAll: "Download all your links as CSV",
      tooBig: "The CSV is larger than 256 KB.",
      tooMany: "Too many imports. Try again in an hour.",
      empty: "The CSV is empty.",
      needTarget: "The first line must name a target_url column.",
      unknownCols: (cols) => `Unknown columns: ${cols}.`,
      noRows: "The CSV has no rows after its header.",
      maxRows: (n) => `At most ${n} links per import.`,
    },
    link: {
      channels: "Links for channels",
      channelsHint: "The same short link with UTM tags, so the stats show where clicks came from.",
      shortFor: (name) => `Short link for ${name}`,
      copyFor: (name) => `Copy for ${name}`,
      qrStyle: "QR colours and caption",
      codeColour: "Code",
      background: "Background",
      caption: "Caption under the code",
      captionHint: "SVG only, up to 40 characters",
      captionPlaceholder: "Scan me",
      apply: "Apply",
      clicks30: (n) => `${n} clicks in 30 days`,
      visitors: (n) => `(${n} visitors at most)`,
      downloadClicks: "Download clicks as CSV",
      referrers: "Sources",
      channelsRanking: "Channels (utm_source)",
      countries: "Countries",
      devices: "Devices",
      edit: "Edit link",
      whereTo: "Where it goes",
      expires: "Expires",
      expiresHint: "UTC, empty for never",
      save: "Save",
      disable: "Disable link",
      enable: "Enable link",
      disabledByUs: (email) => `yoy.fyi disabled this link. If that's a mistake, write to ${email}.`,
      cannotEnable: (why) => `This link can't be enabled: ${why}.`,
      byYoy: "yoy.fyi disabled it",
      notAllowed: (reason) => `the address is not allowed: ${reason}`,
    },
    keys: {
      title: "API keys",
      intro: ["A key works with the ", " or the MCP server at ", ". Keys act only on your own links."],
      newShown: "Your new key, shown only now:",
      newKey: "New key",
      name: "Name",
      namePlaceholder: "my app",
      permissions: "Permissions",
      create: "Create key",
      lastUsed: "last used",
      never: "never",
      revoke: "Revoke",
      errName: "Name: 1-100 characters.",
      errScopes: "Choose at least one of the listed permissions.",
      errMax: (n) => `You can have at most ${n} active keys. Revoke one first.`,
    },
    bioPage: {
      title: "Bio page",
      intro: "One page with your links for an Instagram or Telegram bio",
      address: "Address",
      addressHint: "3-30 characters of a-z 0-9 _ . -",
      heading: "Title",
      description: "Description",
      links: "Links, newest first",
      createFirst: "Create a short link first.",
      save: "Save",
    },
    telegram: { title: "Telegram bot", intro: ["Send a long link to ", " and get the short yoy.fyi link and its QR back."], connected: "Connected.", disconnect: "Disconnect", connect: "Connect Telegram" },
    apps: {
      title: "Connected apps",
      intro: ["To work with your links from a chat, add ", " as a connector in claude.ai or ChatGPT and sign in with the same Google account."],
      disconnectAll: "Disconnect all",
      connected: "connected",
      lastUsed: "last used",
      calls30: (n) => `${n} calls in 30 days`,
      latest: (t) => ` · latest: ${t}`,
      revoke: "Revoke",
      never: "never",
    },
    privacy: {
      title: "Privacy",
      h1: "Privacy at yoy.fyi",
      sections: [
        ["", "yoy.fyi makes short links and counts their clicks. This page says what it stores and for how long."],
        [
          "Your account",
          "When you sign in with Google, yoy.fyi receives and keeps your Google account id, email address and name. It uses them only to sign you in and to show whose links are whose. It reads nothing else from your Google account.",
        ],
        [
          "Clicks on short links",
          "For each click yoy.fyi stores the time, the referring site, UTM and ad-click parameters, the browser, operating system and device type, the country (derived from the IP address, which is not stored), and a daily-changing hash used to count unique visitors. Raw clicks are kept for 13 months; daily totals are kept after that.",
        ],
        [
          "Visits to the site",
          "On public pages (home, blog, docs, bio pages) yoy.fyi counts visits: the page, the time and the site the visitor came from. No cookies, no IP address and no browser data. For search and AI crawlers only their name is recorded. This is kept for 13 months.",
        ],
        [
          "Who sees it",
          "The owner of a link sees its click stats. If the owner set up a webhook, the click details above (never an IP address) are sent to it. yoy.fyi sells nothing to anyone.",
        ],
      ],
      contact: (email) => `Questions or deletion requests: ${email}.`,
    },
    terms: {
      title: "Terms",
      h1: "Terms of use for yoy.fyi",
      paragraphs: [
        "yoy.fyi is offered as is, free of charge, without any guarantee of availability.",
        "Do not create links to phishing, malware, scams, spam or anything illegal. Links and accounts that break this rule are disabled without notice.",
        "Short links can be disabled at any time; a disabled code is never given to anyone else.",
      ],
      contact: (email) => `Contact: ${email}.`,
    },
  },
  es: {
    nav: { keys: "Claves de API", apps: "Aplicaciones conectadas", bio: "Página bio", signOut: "Salir", blog: "Blog", privacy: "Privacidad", terms: "Condiciones", language: "Idioma" },
    scopes: {
      "links:read": "Leer enlaces",
      "links:write": "Crear, cambiar y desactivar enlaces",
      "analytics:read": "Leer estadísticas de clics",
      "webhooks:manage": "Gestionar webhooks de clics",
    },
    status: { active: "activo", expired: "caducado", disabled: "desactivado" },
    fields: {
      target_url: "Dirección (target_url): hasta 2048 caracteres",
      code: "Código propio (code): 1-64 caracteres A-Z a-z 0-9 _ -",
      title: "Título (title): hasta 200 caracteres",
      tags: "Etiquetas (tags): hasta 20 etiquetas distintas de a-z 0-9 _ : . -",
      utm_defaults: "UTM (utm_defaults): valores no válidos",
      preview: "Vista previa (preview): necesita un título de hasta 200 caracteres, una descripción de hasta 500 y una imagen https",
      expires_at: "Caduca (expires_at): una fecha y hora en el futuro",
      pass_click_id: "pass_click_id: sí o no",
    },
    unknownField: (k) => `${k}: valor no válido`,
    codes: {
      code_reserved: "Este código está reservado.",
      code_taken: "Este código ya está ocupado.",
      link_disabled: "Un enlace desactivado no se puede cambiar.",
      idempotency_key_reused: "Una petición repetida con otros datos.",
    },
    reasons: {
      scheme: "la dirección debe empezar por http:// o https://",
      credentials: "la dirección no puede contener usuario y contraseña",
      too_long: "la dirección es demasiado larga",
      own_host: "no se pueden acortar direcciones de yoy.fyi",
      private_address: "no se permiten direcciones privadas ni locales",
      unresolvable: "ese dominio no existe",
      unsafe: "Google Safe Browsing marca esta dirección como peligrosa",
      port: "no se permiten puertos no estándar",
    },
    targetNotAllowed: "La dirección no está permitida",
    previewImageNotAllowed: "La dirección de la imagen de vista previa no está permitida",
    bio: {
      handle: "Dirección (handle): 3-30 caracteres de a-z 0-9 _ . -, empezando por una letra o un número.",
      title: "Título (title): como máximo 100 caracteres.",
      description: "Descripción (description): como máximo 300 caracteres.",
      maxLinks: (n) => `Como máximo ${n} enlaces.`,
      ownLinks: "Elige solo tus propios enlaces (link_ids).",
      taken: (url) => `${url} ya está ocupada.`,
    },
    qr: {
      fg: "El color del código (fg) debe ser como #1a2b3c",
      bg: "El color de fondo (bg) debe ser como #ffffff",
      contrast: "Poco contraste: usa un código oscuro sobre fondo claro",
      caption: (n) => `El texto tiene como máximo ${n} caracteres`,
      svgOnly: "El texto solo está disponible en el SVG",
    },
    csvUnclosed: "El CSV tiene una comilla sin cerrar.",
    preview: { legend: "Vista previa en Telegram, Facebook y otras aplicaciones", title: "Título de la vista previa", description: "Descripción de la vista previa", image: "Dirección de la imagen", imageHint: "https, 1200×630 o más" },
    create: { paste: "Pega un enlace largo", more: "Más opciones", title: "Título", code: "Código propio", codeHint: "yoy.fyi/tu-codigo", tags: "Etiquetas", tagsHint: "separadas por comas", shorten: "Acortar" },
    signInFirst: "Entra primero",
    home: {
      title: "Mis enlaces",
      ready: "Tu enlace corto está listo",
      shortLink: "Enlace corto",
      copy: "Copiar",
      qrFor: (url) => `Código QR de ${url}`,
      downloadQr: "Descargar QR:",
      stats: "Estadísticas",
      firstHint: "Crea tu primer enlace corto: pega abajo una dirección larga y obtén un enlace corto de yoy.fyi con código QR y estadísticas de clics.",
      importCsv: "Importar desde CSV",
      exportCsv: "Exportar a CSV",
      search: "Buscar enlaces",
      searchButton: "Buscar",
      tags: "Etiquetas:",
      showAll: "Mostrar todos",
      nothing: "No se encontró nada.",
      clicks7d: (n) => `${n} clics en 7 días`,
      tooMany: "Demasiados enlaces nuevos. Inténtalo dentro de una hora.",
    },
    importPage: {
      title: "Importar enlaces",
      h1: "Importar enlaces desde CSV",
      intro: ["La primera línea nombra las columnas: ", " (obligatoria), ", " y ", " (separadas por comas, entre comillas)."],
      perFile: (n) => `Hasta ${n} enlaces por archivo.`,
      line: (n) => `Línea ${n}:`,
      shortFromLine: (n) => `Enlace corto de la línea ${n}`,
      file: "Archivo CSV",
      orPaste: "o pégalo aquí",
      button: "Importar",
      downloadAll: "Descargar todos tus enlaces en CSV",
      tooBig: "El CSV supera los 256 KB.",
      tooMany: "Demasiadas importaciones. Inténtalo dentro de una hora.",
      empty: "El CSV está vacío.",
      needTarget: "La primera línea debe tener una columna target_url.",
      unknownCols: (cols) => `Columnas desconocidas: ${cols}.`,
      noRows: "El CSV no tiene filas después del encabezado.",
      maxRows: (n) => `Como máximo ${n} enlaces por importación.`,
    },
    link: {
      channels: "Enlaces por canal",
      channelsHint: "El mismo enlace corto con etiquetas UTM, para que las estadísticas muestren de dónde vienen los clics.",
      shortFor: (name) => `Enlace corto para ${name}`,
      copyFor: (name) => `Copiar para ${name}`,
      qrStyle: "Colores y texto del QR",
      codeColour: "Código",
      background: "Fondo",
      caption: "Texto bajo el código",
      captionHint: "solo en SVG, hasta 40 caracteres",
      captionPlaceholder: "Escanéame",
      apply: "Aplicar",
      clicks30: (n) => `${n} clics en 30 días`,
      visitors: (n) => `(como mucho ${n} visitantes)`,
      downloadClicks: "Descargar clics en CSV",
      referrers: "Orígenes",
      channelsRanking: "Canales (utm_source)",
      countries: "Países",
      devices: "Dispositivos",
      edit: "Editar enlace",
      whereTo: "A dónde lleva",
      expires: "Caduca",
      expiresHint: "UTC, vacío para nunca",
      save: "Guardar",
      disable: "Desactivar enlace",
      enable: "Activar enlace",
      disabledByUs: (email) => `yoy.fyi desactivó este enlace. Si es un error, escribe a ${email}.`,
      cannotEnable: (why) => `Este enlace no se puede activar: ${why}.`,
      byYoy: "lo desactivó yoy.fyi",
      notAllowed: (reason) => `la dirección no está permitida: ${reason}`,
    },
    keys: {
      title: "Claves de API",
      intro: ["Una clave funciona con la ", " o con el servidor MCP en ", ". Las claves solo actúan sobre tus enlaces."],
      newShown: "Tu nueva clave, solo se muestra ahora:",
      newKey: "Nueva clave",
      name: "Nombre",
      namePlaceholder: "mi aplicación",
      permissions: "Permisos",
      create: "Crear clave",
      lastUsed: "último uso",
      never: "nunca",
      revoke: "Revocar",
      errName: "Nombre: 1-100 caracteres.",
      errScopes: "Elige al menos uno de los permisos de la lista.",
      errMax: (n) => `Puedes tener como máximo ${n} claves activas. Revoca una primero.`,
    },
    bioPage: {
      title: "Página bio",
      intro: "Una página con tus enlaces para la bio de Instagram o Telegram",
      address: "Dirección",
      addressHint: "3-30 caracteres de a-z 0-9 _ . -",
      heading: "Título",
      description: "Descripción",
      links: "Enlaces, los nuevos primero",
      createFirst: "Primero crea un enlace corto.",
      save: "Guardar",
    },
    telegram: { title: "Bot de Telegram", intro: ["Envía un enlace largo a ", " y recibe el enlace corto de yoy.fyi y su QR."], connected: "Conectado.", disconnect: "Desconectar", connect: "Conectar Telegram" },
    apps: {
      title: "Aplicaciones conectadas",
      intro: ["Para usar tus enlaces desde un chat, añade ", " como conector en claude.ai o ChatGPT y entra con la misma cuenta de Google."],
      disconnectAll: "Desconectar todas",
      connected: "conectada",
      lastUsed: "último uso",
      calls30: (n) => `${n} llamadas en 30 días`,
      latest: (t) => ` · últimas: ${t}`,
      revoke: "Revocar",
      never: "nunca",
    },
    privacy: {
      title: "Privacidad",
      h1: "Privacidad en yoy.fyi",
      sections: [
        ["", "yoy.fyi crea enlaces cortos y cuenta sus clics. Aquí se explica qué guarda y durante cuánto tiempo."],
        [
          "Tu cuenta",
          "Cuando entras con Google, yoy.fyi recibe y guarda el id de tu cuenta de Google, tu correo y tu nombre. Solo los usa para iniciar tu sesión y mostrar de quién es cada enlace. No lee nada más de tu cuenta de Google.",
        ],
        [
          "Clics en enlaces cortos",
          "Por cada clic, yoy.fyi guarda la hora, el sitio de origen, los parámetros UTM y publicitarios, el navegador, el sistema operativo y el tipo de dispositivo, el país (deducido de la IP, que no se guarda) y un hash que cambia cada día para contar visitantes únicos. Los clics individuales se guardan 13 meses; después solo quedan los totales diarios.",
        ],
        [
          "Visitas al sitio",
          "En las páginas públicas (inicio, blog, documentación, páginas bio) yoy.fyi cuenta las visitas: la página, la hora y el sitio de origen. Sin cookies, sin dirección IP y sin datos del navegador. De los robots de búsqueda e IA solo se guarda el nombre. Esto se conserva 13 meses.",
        ],
        [
          "Quién lo ve",
          "El dueño de un enlace ve sus estadísticas. Si configuró un webhook, se le envían los datos del clic descritos arriba (nunca la IP). yoy.fyi no vende nada a nadie.",
        ],
      ],
      contact: (email) => `Preguntas o solicitudes de borrado: ${email}.`,
    },
    terms: {
      title: "Condiciones",
      h1: "Condiciones de uso de yoy.fyi",
      paragraphs: [
        "yoy.fyi se ofrece tal cual, gratis, sin ninguna garantía de disponibilidad.",
        "No crees enlaces a phishing, malware, estafas, spam ni nada ilegal. Los enlaces y cuentas que incumplan esta regla se desactivan sin aviso.",
        "Los enlaces cortos pueden desactivarse en cualquier momento; un código desactivado nunca se da a otra persona.",
      ],
      contact: (email) => `Contacto: ${email}.`,
    },
  },
  fr: {
    nav: { keys: "Clés d'API", apps: "Applications connectées", bio: "Page bio", signOut: "Se déconnecter", blog: "Blog", privacy: "Confidentialité", terms: "Conditions", language: "Langue" },
    scopes: {
      "links:read": "Lire les liens",
      "links:write": "Créer, modifier et désactiver des liens",
      "analytics:read": "Lire les statistiques de clics",
      "webhooks:manage": "Gérer les webhooks de clics",
    },
    status: { active: "actif", expired: "expiré", disabled: "désactivé" },
    fields: {
      target_url: "Adresse (target_url) : jusqu'à 2048 caractères",
      code: "Code personnalisé (code) : 1 à 64 caractères A-Z a-z 0-9 _ -",
      title: "Titre (title) : jusqu'à 200 caractères",
      tags: "Tags (tags) : jusqu'à 20 tags différents en a-z 0-9 _ : . -",
      utm_defaults: "UTM (utm_defaults) : valeurs invalides",
      preview: "Aperçu (preview) : un titre de 200 caractères au plus, une description de 500 au plus et une image en https",
      expires_at: "Expiration (expires_at) : une date et une heure dans le futur",
      pass_click_id: "pass_click_id : oui ou non",
    },
    unknownField: (k) => `${k} : valeur invalide`,
    codes: {
      code_reserved: "Ce code est réservé.",
      code_taken: "Ce code est déjà pris.",
      link_disabled: "Un lien désactivé ne peut pas être modifié.",
      idempotency_key_reused: "Une requête répétée avec d'autres données.",
    },
    reasons: {
      scheme: "l'adresse doit commencer par http:// ou https://",
      credentials: "l'adresse ne peut pas contenir d'identifiant ni de mot de passe",
      too_long: "l'adresse est trop longue",
      own_host: "les adresses yoy.fyi ne peuvent pas être raccourcies",
      private_address: "les adresses privées et locales sont interdites",
      unresolvable: "ce domaine n'existe pas",
      unsafe: "Google Safe Browsing signale cette adresse comme dangereuse",
      port: "les ports non standard sont interdits",
    },
    targetNotAllowed: "L'adresse n'est pas autorisée",
    previewImageNotAllowed: "L'adresse de l'image d'aperçu n'est pas autorisée",
    bio: {
      handle: "Adresse (handle) : 3 à 30 caractères a-z 0-9 _ . -, commençant par une lettre ou un chiffre.",
      title: "Titre (title) : 100 caractères au plus.",
      description: "Description (description) : 300 caractères au plus.",
      maxLinks: (n) => `${n} liens au plus.`,
      ownLinks: "Choisissez seulement vos propres liens (link_ids).",
      taken: (url) => `${url} est déjà prise.`,
    },
    qr: {
      fg: "La couleur du code (fg) doit ressembler à #1a2b3c",
      bg: "La couleur du fond (bg) doit ressembler à #ffffff",
      contrast: "Contraste insuffisant : utilisez un code foncé sur fond clair",
      caption: (n) => `La légende fait ${n} caractères au plus`,
      svgOnly: "La légende n'existe que dans le SVG",
    },
    csvUnclosed: "Le CSV contient un guillemet non fermé.",
    preview: { legend: "Aperçu dans Telegram, Facebook et d'autres applications", title: "Titre de l'aperçu", description: "Description de l'aperçu", image: "Adresse de l'image", imageHint: "https, 1200×630 ou plus" },
    create: { paste: "Collez un lien long", more: "Plus d'options", title: "Titre", code: "Code personnalisé", codeHint: "yoy.fyi/votre-code", tags: "Tags", tagsHint: "séparés par des virgules", shorten: "Raccourcir" },
    signInFirst: "Connectez-vous d'abord",
    home: {
      title: "Mes liens",
      ready: "Votre lien court est prêt",
      shortLink: "Lien court",
      copy: "Copier",
      qrFor: (url) => `Code QR de ${url}`,
      downloadQr: "Télécharger le QR :",
      stats: "Statistiques",
      firstHint: "Créez votre premier lien court : collez une adresse longue ci-dessous et obtenez un lien court yoy.fyi avec un code QR et les statistiques de clics.",
      importCsv: "Importer un CSV",
      exportCsv: "Exporter en CSV",
      search: "Rechercher des liens",
      searchButton: "Rechercher",
      tags: "Tags :",
      showAll: "Tout afficher",
      nothing: "Aucun résultat.",
      clicks7d: (n) => `${n} clics en 7 jours`,
      tooMany: "Trop de nouveaux liens. Réessayez dans une heure.",
    },
    importPage: {
      title: "Importer des liens",
      h1: "Importer des liens depuis un CSV",
      intro: ["La première ligne nomme les colonnes : ", " (obligatoire), ", " et ", " (séparés par des virgules, entre guillemets)."],
      perFile: (n) => `Jusqu'à ${n} liens par fichier.`,
      line: (n) => `Ligne ${n} :`,
      shortFromLine: (n) => `Lien court de la ligne ${n}`,
      file: "Fichier CSV",
      orPaste: "ou collez-le ici",
      button: "Importer",
      downloadAll: "Télécharger tous vos liens en CSV",
      tooBig: "Le CSV dépasse 256 Ko.",
      tooMany: "Trop d'imports. Réessayez dans une heure.",
      empty: "Le CSV est vide.",
      needTarget: "La première ligne doit contenir une colonne target_url.",
      unknownCols: (cols) => `Colonnes inconnues : ${cols}.`,
      noRows: "Le CSV n'a aucune ligne après l'en-tête.",
      maxRows: (n) => `${n} liens au plus par import.`,
    },
    link: {
      channels: "Liens par canal",
      channelsHint: "Le même lien court avec des balises UTM, pour que les statistiques montrent d'où viennent les clics.",
      shortFor: (name) => `Lien court pour ${name}`,
      copyFor: (name) => `Copier pour ${name}`,
      qrStyle: "Couleurs et légende du QR",
      codeColour: "Code",
      background: "Fond",
      caption: "Légende sous le code",
      captionHint: "SVG uniquement, 40 caractères au plus",
      captionPlaceholder: "Scannez-moi",
      apply: "Appliquer",
      clicks30: (n) => `${n} clics en 30 jours`,
      visitors: (n) => `(${n} visiteurs au plus)`,
      downloadClicks: "Télécharger les clics en CSV",
      referrers: "Sources",
      channelsRanking: "Canaux (utm_source)",
      countries: "Pays",
      devices: "Appareils",
      edit: "Modifier le lien",
      whereTo: "Destination",
      expires: "Expire le",
      expiresHint: "UTC, vide pour jamais",
      save: "Enregistrer",
      disable: "Désactiver le lien",
      enable: "Activer le lien",
      disabledByUs: (email) => `yoy.fyi a désactivé ce lien. Si c'est une erreur, écrivez à ${email}.`,
      cannotEnable: (why) => `Ce lien ne peut pas être activé : ${why}.`,
      byYoy: "yoy.fyi l'a désactivé",
      notAllowed: (reason) => `l'adresse n'est pas autorisée : ${reason}`,
    },
    keys: {
      title: "Clés d'API",
      intro: ["Une clé fonctionne avec l'", " ou le serveur MCP à l'adresse ", ". Les clés n'agissent que sur vos propres liens."],
      newShown: "Votre nouvelle clé, affichée une seule fois :",
      newKey: "Nouvelle clé",
      name: "Nom",
      namePlaceholder: "mon application",
      permissions: "Autorisations",
      create: "Créer la clé",
      lastUsed: "dernière utilisation",
      never: "jamais",
      revoke: "Révoquer",
      errName: "Nom : 1 à 100 caractères.",
      errScopes: "Choisissez au moins une autorisation de la liste.",
      errMax: (n) => `Vous pouvez avoir au plus ${n} clés actives. Révoquez-en une d'abord.`,
    },
    bioPage: {
      title: "Page bio",
      intro: "Une page avec vos liens pour une bio Instagram ou Telegram",
      address: "Adresse",
      addressHint: "3 à 30 caractères a-z 0-9 _ . -",
      heading: "Titre",
      description: "Description",
      links: "Liens, les plus récents d'abord",
      createFirst: "Créez d'abord un lien court.",
      save: "Enregistrer",
    },
    telegram: { title: "Bot Telegram", intro: ["Envoyez un lien long à ", " et recevez le lien court yoy.fyi et son QR."], connected: "Connecté.", disconnect: "Déconnecter", connect: "Connecter Telegram" },
    apps: {
      title: "Applications connectées",
      intro: ["Pour utiliser vos liens depuis un chat, ajoutez ", " comme connecteur dans claude.ai ou ChatGPT et connectez-vous avec le même compte Google."],
      disconnectAll: "Tout déconnecter",
      connected: "connectée",
      lastUsed: "dernière utilisation",
      calls30: (n) => `${n} appels en 30 jours`,
      latest: (t) => ` · derniers : ${t}`,
      revoke: "Révoquer",
      never: "jamais",
    },
    privacy: {
      title: "Confidentialité",
      h1: "Confidentialité sur yoy.fyi",
      sections: [
        ["", "yoy.fyi crée des liens courts et compte leurs clics. Cette page dit ce qu'il conserve et pendant combien de temps."],
        [
          "Votre compte",
          "Quand vous vous connectez avec Google, yoy.fyi reçoit et conserve l'identifiant de votre compte Google, votre e-mail et votre nom. Il s'en sert uniquement pour vous connecter et pour savoir à qui sont les liens. Il ne lit rien d'autre de votre compte Google.",
        ],
        [
          "Clics sur les liens courts",
          "Pour chaque clic, yoy.fyi conserve l'heure, le site d'origine, les paramètres UTM et publicitaires, le navigateur, le système d'exploitation et le type d'appareil, le pays (déduit de l'adresse IP, qui n'est pas conservée) et un hachage qui change chaque jour pour compter les visiteurs uniques. Les clics individuels sont gardés 13 mois, puis seuls les totaux quotidiens restent.",
        ],
        [
          "Visites du site",
          "Sur les pages publiques (accueil, blog, documentation, pages bio), yoy.fyi compte les visites : la page, l'heure et le site d'origine. Sans cookies, sans adresse IP et sans données du navigateur. Pour les robots de recherche et d'IA, seul leur nom est noté. Ces données sont gardées 13 mois.",
        ],
        [
          "Qui les voit",
          "Le propriétaire d'un lien voit ses statistiques. S'il a configuré un webhook, les données de clic décrites ci-dessus lui sont envoyées (jamais l'adresse IP). yoy.fyi ne vend rien à personne.",
        ],
      ],
      contact: (email) => `Questions ou demandes de suppression : ${email}.`,
    },
    terms: {
      title: "Conditions",
      h1: "Conditions d'utilisation de yoy.fyi",
      paragraphs: [
        "yoy.fyi est fourni tel quel, gratuitement, sans aucune garantie de disponibilité.",
        "Ne créez pas de liens vers du phishing, des logiciels malveillants, des arnaques, du spam ou quoi que ce soit d'illégal. Les liens et comptes qui enfreignent cette règle sont désactivés sans préavis.",
        "Les liens courts peuvent être désactivés à tout moment ; un code désactivé n'est jamais attribué à quelqu'un d'autre.",
      ],
      contact: (email) => `Contact : ${email}.`,
    },
  },
};
