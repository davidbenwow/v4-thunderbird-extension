// Internal domains that should be filtered out of all email checks.
// These are OmniScriptum / Lambert imprints and related internal systems.
// Using a Set for O(1) lookup.

const INTERNAL_DOMAINS = new Set([
  'public-ua.com',
  'alphascript-publishing.com',
  'fastbooks.de',
  'doyen-verlag.de',
  'betascript-publishing.com',
  'bloggingbooks.de',
  'yam-publishing.ru',
  'sanktum-publishing.ru',
  'dictus-publishing.eu',
  'verlag-naturleben.de',
  'editiones-originum.de',
  'ejfa-editions.eu',
  'morebooks.de',
  'verlag-lebensreise.de',
  'bezkresywiedzy.com',
  'presse-ai.com',
  'editorial-redactum.com',
  'roditelskie-vstrechi.ru',
  'testsystem.de',
  'testverlag.de',
  'ziarnowiary.com',
  'edicoes-religiosas.com',
  'andakt-forlag.com',
  'edizioni-ai.com',
  'edizioni-santantonio.com',
  'verlag-classic-edition.de',
  'verlag-familienbande.de',
  'turkiye-alim-kitaplary.com',
  'our-colours.com',
  'goldenlight-publishing.com',
  'just-a-life.com',
  'gearup-publishing.com',
  'vivaletra.com',
  'gemstone-books.com',
  'noor-publishing.com',
  'shams-publishing.com',
  'al-ilm-publishing.com',
  'pub.omniscriptum.com',
  'irpress.de',
  'systemtest.io',
  'academic-books.international',
  'omniscriptumpublishing.com',
  'eae-publishing.com',
  'verlag-lehrbuch.de',
  'editions-ue.com',
  'globeedit.com',
  'justfiction-edition.com',
  'lap-publishing.com',
  'frommverlag.de',
  'scholars-press.com',
  'svr-verlag.de',
  'nea-edicoes.com',
  'drugoe-reshenie.ru',
  'editions-muse.com',
  'editions-croix.com',
  'credo-ediciones.com',
  'verlag-trainer.de',
  'akademikerverlag.de',
  'blessedhope-publishing.com',
  'editions-vie.com',
  'palmarium-publishing.ru',
  'svh-verlag.de',
  'editorial-publicia.com',
  'presses-academiques.com',
  'sciencia-scripts.com',
  'hakodesh-press.com',
  'goldenerakete.de',
  'omniscriptum.com'
]);

function isInternalEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  const domain = email.slice(at + 1).toLowerCase().trim();

  // Exact match
  if (INTERNAL_DOMAINS.has(domain)) return true;

  // Subdomain match — e.g. "mail.omniscriptum.com" matches "omniscriptum.com"
  for (const internal of INTERNAL_DOMAINS) {
    if (domain.endsWith('.' + internal)) return true;
  }
  return false;
}
