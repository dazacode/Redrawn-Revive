// Single source of truth for character themes (mirrors the legacy header menus
// in wrapper/static/page.js and wrapper/pages/html/list.html).
// `bodies` are the `bs` (body shape) values for /cc?themeId=<id>&bs=<bs>.
export const THEMES = [
  { group: 'Comedy World', id: 'family', name: 'Comedy World', note: 'The classic GoAnimate look.',
    bodies: [['adam', 'Guy (Adam)'], ['eve', 'Girl (Eve)'], ['bob', 'Fat (Bob)'], ['rocky', 'Buff (Rocky)']] },
  { group: 'Anime', id: 'anime', name: 'Anime', note: 'Big eyes, bigger hair.',
    bodies: [['guy', 'Guy'], ['girl', 'Girl']] },
  { group: 'Anime', id: 'ninjaanime', name: 'Ninja Anime', note: 'Anime with masks and headbands.',
    bodies: [['guy', 'Guy (Ninja)'], ['girl', 'Girl (Ninja)']] },
  { group: 'Peepz', id: 'cc2', name: "Lil' Peepz", note: 'Small, round and simple.', bodies: [['default', "Lil' Peepz"]] },
  { group: 'Peepz', id: 'chibi', name: 'Chibi Peepz', note: 'Chibi proportions.', bodies: [['default', 'Chibi Peepz']] },
  { group: 'Peepz', id: 'ninja', name: 'Chibi Ninjas', note: 'Chibi, but stealthy.', bodies: [['default', 'Chibi Ninjas']] },
  { group: 'Space Citizens', id: 'spacecitizen', name: 'Space Citizens', note: 'Sci-fi crew members.',
    bodies: [['guy', 'Guy'], ['muscular_guy', 'Guy (Buff)'], ['girl', 'Girl']] },
];

// "Short theme list" setting: the legacy cookie hides the extra themes server-side,
// so the frontend mirrors that by dropping them from its own lists.
export const SHORT_LIST_IDS = ['family', 'anime', 'ninjaanime', 'cc2', 'chibi', 'ninja'];

export const themeById = (id) => THEMES.find((t) => t.id === id);
export function visibleThemes(short) {
  return short ? THEMES.filter((t) => SHORT_LIST_IDS.includes(t.id)) : THEMES;
}
