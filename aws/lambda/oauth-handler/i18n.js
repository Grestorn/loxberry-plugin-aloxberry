'use strict';

// User-facing strings for the OAuth handler's HTML pages. The Alexa-app
// WebView opens these during account linking and carries the device locale
// in Accept-Language; we honour it where we have a translation and fall back
// to English everywhere else.
//
// Why hand-rolled and not a real i18n library: ~30 strings, 5 locales, no
// runtime hot-reload requirement, and Lambda cold-start cost matters. A
// dependency-free t() + pickLocale beats bundling 200 KB of intl-messageformat.
//
// Scope mirrors where Alexa is actually sold and where the Alexa Developer
// Console supports a marketplace locale: en (en-GB/en-US), de, fr, it, es,
// nl. Users in countries Alexa doesn't ship to (Scandinavia, Poland, etc.)
// link via their Alexa account's locale anyway and will land on en or de.

const SUPPORTED_LOCALES = ['en', 'de', 'fr', 'it', 'es', 'nl'];
const DEFAULT_LOCALE = 'en';

// Translation table. Flat keys; each entry maps locale → string.
// Placeholders are `{name}` and are substituted by t() at render time.
// Static <em>/<strong> markup IS allowed inside translations — every value
// here is hand-written, never user input, so HTML escaping is not needed
// for the literal strings. Per-call variables substituted into translations
// still pass through escapeHtml() at the rendering site.
const TRANSLATIONS = {
  // ---- Authorize form (the pair-code entry page) -------------------------
  'auth_form.title': {
    en: 'Link Aloxberry to Alexa',
    de: 'Aloxberry mit Alexa verknüpfen',
    fr: 'Lier Aloxberry à Alexa',
    it: 'Collega Aloxberry ad Alexa',
    es: 'Vincular Aloxberry con Alexa',
    nl: 'Aloxberry koppelen met Alexa',
  },
  'auth_form.heading': {
    en: 'Link your Aloxberry plugin to Alexa',
    de: 'Deine Aloxberry-Skill mit Alexa verknüpfen',
    fr: 'Lier votre plugin Aloxberry à Alexa',
    it: 'Collega il tuo plugin Aloxberry ad Alexa',
    es: 'Vincula tu plugin Aloxberry con Alexa',
    nl: 'Koppel je Aloxberry-plugin met Alexa',
  },
  'auth_form.lead': {
    en: "To link, enter the <strong>10-character pair code</strong> from the Aloxberry plugin's web UI. The code is one-shot and expires after 10 minutes.",
    de: 'Zur Verknüpfung gib unten den <strong>10-stelligen Pair-Code</strong> aus der Web-Oberfläche der Aloxberry-Skill ein. Der Code ist einmal verwendbar und läuft nach 10 Minuten ab.',
    fr: "Pour lier, saisissez le <strong>code d'appairage à 10 caractères</strong> depuis l'interface web du plugin Aloxberry. Le code est à usage unique et expire après 10 minutes.",
    it: "Per collegare, inserisci il <strong>codice di abbinamento da 10 caratteri</strong> dall'interfaccia web del plugin Aloxberry. Il codice è monouso e scade dopo 10 minuti.",
    es: 'Para vincular, introduce el <strong>código de emparejamiento de 10 caracteres</strong> desde la interfaz web del plugin Aloxberry. El código es de un solo uso y caduca a los 10 minutos.',
    nl: 'Om te koppelen voer je de <strong>pair-code van 10 tekens</strong> uit de webinterface van de Aloxberry-plugin in. De code is eenmalig en vervalt na 10 minuten.',
  },
  'auth_form.step1': {
    en: 'Open your LoxBerry → Plugins → Aloxberry.',
    de: 'Öffne deinen LoxBerry → Plugins → Aloxberry.',
    fr: 'Ouvrez votre LoxBerry → Plugins → Aloxberry.',
    it: 'Apri il tuo LoxBerry → Plugin → Aloxberry.',
    es: 'Abre tu LoxBerry → Plugins → Aloxberry.',
    nl: 'Open je LoxBerry → Plugins → Aloxberry.',
  },
  'auth_form.step2': {
    en: 'Click <em>Show pair code</em>.',
    de: 'Klicke auf <em>Pair-Code anzeigen</em>.',
    fr: "Cliquez sur <em>Afficher le code d'appairage</em>.",
    it: 'Fai clic su <em>Mostra codice di abbinamento</em>.',
    es: 'Haz clic en <em>Mostrar código de emparejamiento</em>.',
    nl: 'Klik op <em>Pair-code tonen</em>.',
  },
  'auth_form.step3': {
    en: 'Type or paste the 10 characters below.',
    de: 'Tippe oder füge die 10 Zeichen unten ein.',
    fr: 'Tapez ou collez les 10 caractères ci-dessous.',
    it: 'Digita o incolla i 10 caratteri qui sotto.',
    es: 'Escribe o pega los 10 caracteres aquí debajo.',
    nl: 'Typ of plak de 10 tekens hieronder.',
  },
  'auth_form.label_pair_code': {
    en: 'Pair code',
    de: 'Pair-Code',
    fr: "Code d'appairage",
    it: 'Codice di abbinamento',
    es: 'Código de emparejamiento',
    nl: 'Pair-code',
  },
  'auth_form.hint_pair_code': {
    en: '10 characters: A-Z (no I, O) and 2-9. Lowercase is converted automatically.',
    de: '10 Zeichen: A–Z (ohne I, O) und 2–9. Kleinbuchstaben werden automatisch umgewandelt.',
    fr: '10 caractères : A–Z (sans I, O) et 2–9. Les minuscules sont converties automatiquement.',
    it: '10 caratteri: A–Z (senza I, O) e 2–9. Le lettere minuscole vengono convertite automaticamente.',
    es: '10 caracteres: A–Z (sin I, O) y 2–9. Las minúsculas se convierten automáticamente.',
    nl: '10 tekens: A-Z (zonder I, O) en 2-9. Kleine letters worden automatisch omgezet.',
  },
  'auth_form.label_friendly_name': {
    en: 'Friendly name (optional)',
    de: 'Anzeigename (optional)',
    fr: 'Nom convivial (facultatif)',
    it: 'Nome descrittivo (facoltativo)',
    es: 'Nombre amigable (opcional)',
    nl: 'Weergavenaam (optioneel)',
  },
  'auth_form.hint_friendly_name': {
    en: 'Shown in the Alexa app to help you tell linked homes apart.',
    de: 'Wird in der Alexa-App angezeigt, um verknüpfte Häuser unterscheiden zu können.',
    fr: "Affiché dans l'application Alexa pour distinguer les maisons liées.",
    it: "Mostrato nell'app Alexa per distinguere le abitazioni collegate.",
    es: 'Se muestra en la app de Alexa para distinguir las casas vinculadas.',
    nl: 'Wordt in de Alexa-app getoond om gekoppelde huizen uit elkaar te houden.',
  },
  'auth_form.placeholder_friendly_name': {
    en: 'Home',
    de: 'Zuhause',
    fr: 'Maison',
    it: 'Casa',
    es: 'Casa',
    nl: 'Thuis',
  },
  'auth_form.button': {
    en: 'Link this Aloxberry',
    de: 'Diesen Aloxberry verknüpfen',
    fr: 'Lier cet Aloxberry',
    it: 'Collega questo Aloxberry',
    es: 'Vincular este Aloxberry',
    nl: 'Deze Aloxberry koppelen',
  },
  // Voice-code reminder. Amazon's security requirements for skills that can
  // unlock or open something ask that the account-linking page give the user
  // the chance to set a voice code, and remind them not to reuse a code they
  // use elsewhere. Alexa owns the code end to end - it is set per device in
  // the Alexa app, checked in Amazon's cloud, and never travels to the skill,
  // the bridge or the LoxBerry. Saying so plainly here is also the honest
  // answer to "where does my garage door PIN live?".
  'auth_form.voice_code_title': {
    en: 'Opening a garage door or gate?',
    de: 'Garagentor oder Hoftor freigeben?',
    fr: 'Vous exposez une porte de garage ou un portail ?',
    it: 'Esponi una porta del garage o un cancello?',
    es: '¿Vas a exponer una puerta de garaje o una cancela?',
    nl: 'Een garagedeur of poort delen?',
  },
  'auth_form.voice_code_body': {
    en: 'Set a <strong>voice code</strong> for it in the Alexa app under Devices → the device → Voice code. Alexa then asks for that code before it opens the door. Pick a code you do not use for any other account or service — Amazon checks it, and Aloxberry never sees it.',
    de: 'Hinterlege dafür in der Alexa-App unter Geräte → das Gerät → Sprachcode einen <strong>Sprachcode</strong>. Alexa fragt dann vor dem Öffnen nach diesem Code. Wähle einen Code, den du für kein anderes Konto und keinen anderen Dienst verwendest — geprüft wird er von Amazon, Aloxberry sieht ihn nie.',
    fr: "Définissez-lui un <strong>code vocal</strong> dans l'application Alexa sous Appareils → l'appareil → Code vocal. Alexa demandera ce code avant d'ouvrir. Choisissez un code que vous n'utilisez pour aucun autre compte ou service — c'est Amazon qui le vérifie, Aloxberry ne le voit jamais.",
    it: "Imposta per quel dispositivo un <strong>codice vocale</strong> nell'app Alexa in Dispositivi → il dispositivo → Codice vocale. Alexa lo chiederà prima di aprire. Scegli un codice che non usi per nessun altro account o servizio — lo verifica Amazon, Aloxberry non lo vede mai.",
    es: 'Configúrale un <strong>código de voz</strong> en la app de Alexa, en Dispositivos → el dispositivo → Código de voz. Alexa pedirá ese código antes de abrir. Elige un código que no uses en ninguna otra cuenta ni servicio: lo comprueba Amazon y Aloxberry nunca lo ve.',
    nl: 'Stel er in de Alexa-app een <strong>spraakcode</strong> voor in via Apparaten → het apparaat → Spraakcode. Alexa vraagt die code dan voordat de deur opengaat. Kies een code die je voor geen enkel ander account of andere dienst gebruikt — Amazon controleert hem en Aloxberry ziet hem nooit.',
  },
  'auth_form.err_pair_required': {
    en: "A pair code is required. Generate one in the Aloxberry plugin's web UI.",
    de: 'Ein Pair-Code wird benötigt. Erzeuge einen in der Web-Oberfläche der Aloxberry-Skill.',
    fr: "Un code d'appairage est requis. Générez-en un dans l'interface web du plugin Aloxberry.",
    it: "È richiesto un codice di abbinamento. Generane uno nell'interfaccia web del plugin Aloxberry.",
    es: 'Se requiere un código de emparejamiento. Genera uno en la interfaz web del plugin Aloxberry.',
    nl: 'Een pair-code is vereist. Genereer er een in de webinterface van de Aloxberry-plugin.',
  },
  'auth_form.err_pair_bad_format': {
    en: 'Pair code must be exactly 10 characters from the set A-Z (no I, O) and 2-9. Check for typos and try again.',
    de: 'Der Pair-Code muss aus genau 10 Zeichen aus dem Bereich A–Z (ohne I, O) und 2–9 bestehen. Bitte auf Tippfehler prüfen und erneut versuchen.',
    fr: "Le code d'appairage doit comporter exactement 10 caractères parmi A–Z (sans I, O) et 2–9. Vérifiez les fautes de frappe et réessayez.",
    it: "Il codice di abbinamento deve essere esattamente di 10 caratteri tra A–Z (senza I, O) e 2–9. Controlla eventuali errori di battitura e riprova.",
    es: 'El código de emparejamiento debe tener exactamente 10 caracteres del conjunto A–Z (sin I, O) y 2–9. Comprueba si hay erratas e inténtalo de nuevo.',
    nl: 'De pair-code moet exact 10 tekens lang zijn uit de set A-Z (zonder I, O) en 2-9. Controleer op typefouten en probeer het opnieuw.',
  },

  // ---- Pair-code redemption (bridge round-trip errors) -------------------
  'pair.err_bridge_malformed': {
    en: 'Bridge returned an unexpected response. Try again or contact the operator.',
    de: 'Die Bridge hat eine unerwartete Antwort gesendet. Versuche es erneut oder kontaktiere den Betreiber.',
    fr: "La bridge a renvoyé une réponse inattendue. Réessayez ou contactez l'opérateur.",
    it: "La bridge ha restituito una risposta inattesa. Riprova o contatta l'operatore.",
    es: 'La bridge devolvió una respuesta inesperada. Inténtalo de nuevo o contacta con el operador.',
    nl: 'De bridge heeft een onverwacht antwoord teruggegeven. Probeer het opnieuw of neem contact op met de beheerder.',
  },
  'pair.err_not_found': {
    en: "That code is not recognized. It may have expired (codes last 10 minutes), already been used, or never been generated. Go back to the Aloxberry plugin's web UI, generate a fresh code, and paste it here.",
    de: 'Dieser Code wird nicht erkannt. Er ist möglicherweise abgelaufen (Codes sind 10 Minuten gültig), bereits verwendet worden oder wurde nie erzeugt. Wechsle zurück in die Web-Oberfläche der Aloxberry-Skill, erzeuge einen neuen Code und füge ihn hier ein.',
    fr: "Ce code n'est pas reconnu. Il a peut-être expiré (les codes durent 10 minutes), déjà été utilisé, ou n'a jamais été généré. Retournez dans l'interface web du plugin Aloxberry, générez un nouveau code et collez-le ici.",
    it: "Questo codice non è riconosciuto. Potrebbe essere scaduto (i codici durano 10 minuti), già essere stato usato, o non essere mai stato generato. Torna nell'interfaccia web del plugin Aloxberry, genera un nuovo codice e incollalo qui.",
    es: 'Este código no se reconoce. Puede haber caducado (los códigos duran 10 minutos), haberse usado ya, o no haberse generado nunca. Vuelve a la interfaz web del plugin Aloxberry, genera un código nuevo y pégalo aquí.',
    nl: 'Deze code wordt niet herkend. Mogelijk is hij vervallen (codes zijn 10 minuten geldig), al gebruikt, of nooit gegenereerd. Ga terug naar de webinterface van de Aloxberry-plugin, genereer een nieuwe code en plak hem hier.',
  },
  'pair.err_bridge_unauthorized': {
    en: 'Bridge configuration error (auth failed). Please contact the operator.',
    de: 'Bridge-Konfigurationsfehler (Authentifizierung fehlgeschlagen). Bitte den Betreiber kontaktieren.',
    fr: "Erreur de configuration de la bridge (échec d'authentification). Veuillez contacter l'opérateur.",
    it: "Errore di configurazione della bridge (autenticazione fallita). Contatta l'operatore.",
    es: 'Error de configuración de la bridge (autenticación fallida). Por favor, contacta con el operador.',
    nl: 'Bridge-configuratiefout (authenticatie mislukt). Neem contact op met de beheerder.',
  },
  'pair.err_bridge_not_configured': {
    en: 'Bridge is not yet configured. Please try again later.',
    de: 'Die Bridge ist noch nicht konfiguriert. Bitte später erneut versuchen.',
    fr: "La bridge n'est pas encore configurée. Veuillez réessayer plus tard.",
    it: 'La bridge non è ancora configurata. Riprova più tardi.',
    es: 'La bridge aún no está configurada. Inténtalo de nuevo más tarde.',
    nl: 'De bridge is nog niet geconfigureerd. Probeer het later opnieuw.',
  },
  'pair.err_http_status': {
    en: 'Bridge returned an unexpected HTTP {status}. Try again shortly.',
    de: 'Die Bridge hat einen unerwarteten HTTP-Status {status} gemeldet. Versuche es in Kürze erneut.',
    fr: 'La bridge a renvoyé un HTTP {status} inattendu. Réessayez sous peu.',
    it: 'La bridge ha restituito un HTTP {status} inatteso. Riprova a breve.',
    es: 'La bridge devolvió un HTTP {status} inesperado. Inténtalo de nuevo en breve.',
    nl: 'De bridge gaf een onverwachte HTTP {status} terug. Probeer het binnenkort opnieuw.',
  },
  'pair.err_timeout': {
    en: 'Bridge did not respond within {ms}ms. Try again.',
    de: 'Die Bridge hat nicht innerhalb von {ms} ms geantwortet. Bitte erneut versuchen.',
    fr: "La bridge n'a pas répondu dans les {ms} ms. Réessayez.",
    it: 'La bridge non ha risposto entro {ms} ms. Riprova.',
    es: 'La bridge no respondió en {ms} ms. Inténtalo de nuevo.',
    nl: 'De bridge reageerde niet binnen {ms} ms. Probeer het opnieuw.',
  },
  'pair.err_unreachable': {
    en: 'Could not reach the bridge: {error}. Try again in a minute.',
    de: 'Die Bridge konnte nicht erreicht werden: {error}. Bitte in einer Minute erneut versuchen.',
    fr: 'Impossible de joindre la bridge : {error}. Réessayez dans une minute.',
    it: 'Impossibile raggiungere la bridge: {error}. Riprova tra un minuto.',
    es: 'No se pudo contactar con la bridge: {error}. Inténtalo de nuevo en un minuto.',
    nl: 'De bridge kon niet worden bereikt: {error}. Probeer het over een minuut opnieuw.',
  },

  // ---- Beta-full page ----------------------------------------------------
  'beta.title': {
    en: 'Aloxberry beta is full',
    de: 'Aloxberry-Beta ist voll',
    fr: "La bêta d'Aloxberry est pleine",
    it: 'La beta di Aloxberry è al completo',
    es: 'La beta de Aloxberry está llena',
    nl: 'Aloxberry-bèta zit vol',
  },
  'beta.heading': {
    en: 'The Aloxberry beta is currently full 🚧',
    de: 'Die Aloxberry-Beta ist aktuell voll 🚧',
    fr: "La bêta d'Aloxberry est actuellement pleine 🚧",
    it: 'La beta di Aloxberry è attualmente al completo 🚧',
    es: 'La beta de Aloxberry está actualmente llena 🚧',
    nl: 'De Aloxberry-bèta zit op dit moment vol 🚧',
  },
  'beta.body_main': {
    en: "Thanks for your interest! Aloxberry is still in a limited beta, capped at <strong>{limit}</strong> connected LoxBerry installations so we can keep an eye on stability. That limit is reached right now, so we can't link a new installation just yet.",
    de: 'Danke für dein Interesse! Aloxberry befindet sich noch in einer begrenzten Beta-Phase, gedeckelt auf <strong>{limit}</strong> verbundene LoxBerry-Installationen, damit wir die Stabilität im Auge behalten können. Dieses Limit ist gerade erreicht, daher können wir derzeit keine neue Installation verknüpfen.',
    fr: "Merci de votre intérêt ! Aloxberry est encore en bêta limitée, plafonnée à <strong>{limit}</strong> installations LoxBerry connectées afin que nous puissions surveiller la stabilité. Cette limite est atteinte actuellement, nous ne pouvons donc pas lier une nouvelle installation pour l'instant.",
    it: "Grazie per l'interesse! Aloxberry è ancora in una beta limitata, con un limite di <strong>{limit}</strong> installazioni LoxBerry collegate per poterne monitorare la stabilità. Quel limite è raggiunto in questo momento, quindi non possiamo ancora collegare una nuova installazione.",
    es: '¡Gracias por tu interés! Aloxberry sigue en beta limitada, con un máximo de <strong>{limit}</strong> instalaciones LoxBerry conectadas para poder vigilar la estabilidad. Ese límite se ha alcanzado ahora mismo, por lo que aún no podemos vincular una instalación nueva.',
    nl: 'Bedankt voor je interesse! Aloxberry zit nog in een beperkte bètafase, gemaximeerd op <strong>{limit}</strong> aangesloten LoxBerry-installaties zodat we de stabiliteit in het oog kunnen houden. Die limiet is op dit moment bereikt, dus kunnen we voorlopig geen nieuwe installatie koppelen.',
  },
  'beta.forum_pending': {
    en: 'A place to request an additional slot is coming soon — please check back, or watch the Aloxberry plugin announcements.',
    de: 'Eine Möglichkeit, einen weiteren Slot anzufragen, kommt bald — bitte schau später wieder vorbei oder verfolge die Aloxberry-Plugin-Ankündigungen.',
    fr: "Un endroit pour demander un emplacement supplémentaire arrive bientôt — n'hésitez pas à revenir, ou surveillez les annonces du plugin Aloxberry.",
    it: 'Presto sarà disponibile un luogo per richiedere uno slot aggiuntivo — torna a controllare, o segui gli annunci del plugin Aloxberry.',
    es: 'Próximamente habrá un sitio para solicitar una plaza adicional — vuelve más tarde, o mantente atento a los anuncios del plugin Aloxberry.',
    nl: 'Een plek om een extra plaats aan te vragen komt binnenkort — kom later nog eens terug, of houd de aankondigingen van de Aloxberry-plugin in de gaten.',
  },
  'beta.forum_link_intro': {
    en: 'Want in sooner? You can ask for an additional slot here:',
    de: 'Du willst früher dabei sein? Du kannst hier einen weiteren Slot anfragen:',
    fr: 'Vous voulez entrer plus tôt ? Vous pouvez demander un emplacement supplémentaire ici :',
    it: 'Vuoi entrare prima? Puoi richiedere uno slot aggiuntivo qui:',
    es: '¿Quieres entrar antes? Puedes solicitar una plaza adicional aquí:',
    nl: 'Wil je er eerder bij zijn? Je kunt hier een extra plek aanvragen:',
  },
  'beta.body_already_linked': {
    en: 'If you have <em>already</em> linked this LoxBerry before, adding another Alexa account to it still works — this message only appears for brand-new installations.',
    de: 'Wenn du diesen LoxBerry <em>bereits</em> früher verknüpft hast, kannst du weiterhin weitere Alexa-Konten hinzufügen — diese Meldung erscheint nur bei brandneuen Installationen.',
    fr: "Si vous avez <em>déjà</em> lié ce LoxBerry auparavant, ajouter un autre compte Alexa fonctionne toujours — ce message ne s'affiche que pour les installations toutes neuves.",
    it: "Se hai <em>già</em> collegato questo LoxBerry in precedenza, aggiungere un altro account Alexa funziona comunque — questo messaggio appare solo per le installazioni nuovissime.",
    es: 'Si <em>ya</em> has vinculado este LoxBerry antes, añadirle otra cuenta de Alexa sigue funcionando — este mensaje solo aparece para instalaciones totalmente nuevas.',
    nl: 'Als je deze LoxBerry <em>al eerder</em> hebt gekoppeld, blijft het toevoegen van een ander Alexa-account werken — dit bericht verschijnt alleen bij gloednieuwe installaties.',
  },

  // ---- Generic error page ------------------------------------------------
  'error.title': {
    en: 'Error',
    de: 'Fehler',
    fr: 'Erreur',
    it: 'Errore',
    es: 'Error',
    nl: 'Fout',
  },
  'error.heading': {
    en: 'Something went wrong',
    de: 'Etwas ist schiefgelaufen',
    fr: "Quelque chose s'est mal passé",
    it: 'Qualcosa è andato storto',
    es: 'Algo ha salido mal',
    nl: 'Er ging iets mis',
  },
  'error.invalid_redirect': {
    en: 'Invalid or untrusted redirect_uri.',
    de: 'Ungültige oder nicht vertrauenswürdige redirect_uri.',
    fr: 'redirect_uri invalide ou non approuvée.',
    it: 'redirect_uri non valido o non attendibile.',
    es: 'redirect_uri no válida o no de confianza.',
    nl: 'Ongeldige of niet-vertrouwde redirect_uri.',
  },
  'error.config_retry': {
    en: 'Server configuration error — please retry shortly.',
    de: 'Server-Konfigurationsfehler — bitte in Kürze erneut versuchen.',
    fr: 'Erreur de configuration du serveur — veuillez réessayer sous peu.',
    it: 'Errore di configurazione del server — riprova a breve.',
    es: 'Error de configuración del servidor — inténtalo de nuevo en breve.',
    nl: 'Serverconfiguratiefout — probeer het binnenkort opnieuw.',
  },
  'error.bridge_unconfigured': {
    en: 'Bridge is not configured. Contact the operator.',
    de: 'Bridge ist nicht konfiguriert. Bitte den Betreiber kontaktieren.',
    fr: "La bridge n'est pas configurée. Contactez l'opérateur.",
    it: "La bridge non è configurata. Contatta l'operatore.",
    es: 'La bridge no está configurada. Contacta con el operador.',
    nl: 'De bridge is niet geconfigureerd. Neem contact op met de beheerder.',
  },
  'error.oauth_generic': {
    en: 'OAuth error: {code}',
    de: 'OAuth-Fehler: {code}',
    fr: 'Erreur OAuth : {code}',
    it: 'Errore OAuth: {code}',
    es: 'Error de OAuth: {code}',
    nl: 'OAuth-fout: {code}',
  },
};

// Resolve a translation. Locale falls back to default if unknown; an unknown
// key returns the key itself (visible in dev — better than a silent blank).
function t(locale, key, vars) {
  const lang = SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  const entry = TRANSLATIONS[key];
  if (!entry) return key;
  let s = entry[lang] || entry[DEFAULT_LOCALE] || key;
  if (vars) {
    for (const k of Object.keys(vars)) {
      s = s.split('{' + k + '}').join(String(vars[k]));
    }
  }
  return s;
}

// Parse RFC 4647 Accept-Language and pick the best supported locale.
//
//   "fr-FR,fr;q=0.9,en;q=0.8" → "fr"
//   "pl,en-GB;q=0.7"          → "en"   (pl unsupported, en-GB matches en)
//   "*"                       → "en"   (wildcard ignored)
//   ""                        → "en"
//
// Match strategy per RFC 4647 §3.4 (Lookup): try the full tag first, then
// strip subtags from the right until a match or the tag is exhausted. Our
// SUPPORTED_LOCALES are primary-tag only, so in practice this means "try
// exact (won't match), then primary (will match if supported)."
function pickLocale(acceptLanguage) {
  if (typeof acceptLanguage !== 'string' || !acceptLanguage.trim()) {
    return DEFAULT_LOCALE;
  }
  const entries = [];
  for (const raw of acceptLanguage.split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const semi = trimmed.indexOf(';');
    const tag = (semi >= 0 ? trimmed.slice(0, semi) : trimmed).toLowerCase().trim();
    let q = 1;
    if (semi >= 0) {
      const m = trimmed.slice(semi + 1).match(/q\s*=\s*([\d.]+)/i);
      if (m) {
        const parsed = parseFloat(m[1]);
        if (Number.isFinite(parsed)) q = parsed;
      }
    }
    entries.push({ tag, q });
  }
  // Stable sort by q descending. Within same q, preserve order — RFC says
  // Accept-Language is unordered but most browsers send in preference order.
  entries.sort((a, b) => b.q - a.q);

  for (const { tag, q } of entries) {
    if (!tag || tag === '*' || q <= 0) continue;
    if (SUPPORTED_LOCALES.includes(tag)) return tag;
    const dash = tag.indexOf('-');
    if (dash > 0) {
      const primary = tag.slice(0, dash);
      if (SUPPORTED_LOCALES.includes(primary)) return primary;
    }
  }
  return DEFAULT_LOCALE;
}

// Constrain an arbitrary locale string to a known value. Used at the boundary
// where a locale comes off the wire (hidden form field, query param) and must
// be safe to interpolate into <html lang="..."> and a hidden input value.
function normalizeLocale(locale) {
  return SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
}

module.exports = {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  pickLocale,
  normalizeLocale,
  t,
};
