// Flashvars construction. This mirrors wrapper/static/page.js EXACTLY (keys, values,
// order, attrs, and the "query string overrides defaults" behaviour). If page.js
// changes, change this file and nothing else.
//
// Legacy template values SWF_URL / STORE_URL / CLIENT_URL come from the backend
// (wrapper env.json). We get them from api.config() and pass them in as `cfg`.
// The literal "<store>" and "<client_theme>" tokens are placeholders the SWF itself
// substitutes; do not replace them.

/** page.js toAttrString(table) for objects: null values dropped, key/value URI-encoded. */
export function encodeFlashvars(table) {
  if (typeof table !== 'object' || table === null) return String(table ?? '');
  return Object.keys(table)
    .filter((key) => table[key] !== null)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(table[key])}`)
    .join('&');
}

export const EDITOR_TYPES = ['cc', 'cc_browser', 'go_full', 'player'];

/**
 * @param {'cc'|'cc_browser'|'go_full'|'player'} type  legacy route name
 * @param {Record<string,string>} query                page query (minus our own `type`)
 * @param {{SWF_URL:string,STORE_URL:string,CLIENT_URL:string}} cfg
 * @param {{presaveId?:string}} [extra]                go_full only: id from the backend session call
 * @returns {{title:string, swfUrl:string, flashvars:Record<string,any>, width:string, height:string,
 *            allowFullScreen:boolean, allowScriptAccess:string}}
 */
export function buildEditorSpec(type, query, cfg, extra = {}) {
  const store = cfg.STORE_URL + '/<store>';
  const clientTheme = cfg.CLIENT_URL + '/<client_theme>';
  let title, swf, flashvars, width, height, allowFullScreen = false;

  switch (type) {
    case 'cc':
      title = 'Character Creator';
      swf = '/cc.swf'; width = '960'; height = '600';
      flashvars = {
        apiserver: '/', storePath: store,
        clientThemePath: clientTheme, original_asset_id: query['id'] || null,
        themeId: 'family', ut: 60, bs: 'adam', appCode: 'go', page: '', siteId: 'go',
        m_mode: 'school', isLogin: 'Y', isEmbed: 1, ctc: 'go', tlang: 'en_US',
      };
      break;

    case 'cc_browser':
      title = 'CC Browser';
      swf = '/cc_browser.swf'; width = '100%'; height = '600';
      flashvars = {
        apiserver: '/', storePath: store, clientThemePath: clientTheme,
        original_asset_id: query['id'] || null,
        themeId: 'family', ut: 60, appCode: 'go', page: '', siteId: 'go',
        m_mode: 'school', isLogin: 'Y', retut: 1, goteam_draft_only: 1,
        isEmbed: 1, ctc: 'go', tlang: 'en_US', lid: 13,
      };
      break;

    case 'go_full': {
      // page.js: movieId starting with "m" is used as-is, else a fresh presave id.
      const presave = query.movieId && query.movieId.startsWith('m') ? query.movieId : extra.presaveId;
      title = 'Video Editor';
      swf = '/go_full.swf'; width = '100%'; height = '100%';
      flashvars = {
        apiserver: '/', storePath: store, isEmbed: 1, ctc: 'go',
        ut: 60, bs: 'default', appCode: 'go', page: '', siteId: 'go', lid: 13, isLogin: 'Y', retut: 1,
        clientThemePath: clientTheme, themeId: 'business', tlang: 'en_US',
        presaveId: presave, goteam_draft_only: 1, isWide: 1, nextUrl: '/pages/html/list.html',
      };
      break;
    }

    case 'player':
      title = 'Video Player';
      swf = '/player.swf'; width = '100%'; height = '100%'; allowFullScreen = true;
      flashvars = {
        apiserver: '/', storePath: store, ut: 60,
        autostart: 1, isWide: 1, clientThemePath: clientTheme,
      };
      break;

    default:
      throw new Error(`Unknown editor type: ${type}`);
  }

  // page.js: Object.assign(params.flashvars, query)  (query wins)
  Object.assign(flashvars, query);

  return {
    title, swfUrl: cfg.SWF_URL + swf, flashvars, width, height,
    allowFullScreen, allowScriptAccess: 'always',
  };
}
