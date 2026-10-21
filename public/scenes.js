/* KERNL genre scenes: black-and-white vector art on a colour, one per genre group.
   Each book is drawn from its group's scene. Art is plain SVG so it stays sharp at any size. */
(function () {
  'use strict';
  var K = '#17122b', W = '#ffffff';

  function star(x, y, r, fill) {
    return '<path d="M' + x + ' ' + (y - r) + 'Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y + 'Q' + x + ' ' + y + ' ' + x + ' ' + (y + r) + 'Q' + x + ' ' + y + ' ' + (x - r) + ' ' + y + 'Q' + x + ' ' + y + ' ' + x + ' ' + (y - r) + 'Z" fill="' + (fill || K) + '"/>';
  }

  var ART = {
    business:
      '<rect x="34" y="120" width="30" height="46" rx="5" fill="' + K + '"/>' +
      '<rect x="84" y="94" width="30" height="72" rx="5" fill="' + K + '"/>' +
      '<rect x="134" y="64" width="30" height="102" rx="5" fill="' + K + '"/>' +
      '<rect x="22" y="166" width="156" height="7" rx="3.5" fill="' + K + '"/>' +
      '<path d="M40 92 L90 62 L118 76 L160 38" fill="none" stroke="' + K + '" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M142 34 L168 30 L164 56Z" fill="' + K + '" stroke="' + K + '" stroke-width="4" stroke-linejoin="round"/>' +
      '<circle cx="52" cy="50" r="18" fill="' + W + '" stroke="' + K + '" stroke-width="6"/>' +
      '<text x="52" y="58" text-anchor="middle" font-family="Plus Jakarta Sans,Arial,sans-serif" font-weight="800" font-size="22" fill="' + K + '">&#163;</text>',

    mind:
      '<path d="M66 172 L66 142 C38 130 34 96 48 72 C62 46 98 34 126 48 C152 61 158 90 150 106 L162 118 L148 124 L150 140 C150 152 138 154 124 152 L124 172Z" fill="' + K + '"/>' +
      '<g fill="none" stroke="' + W + '" stroke-width="5" stroke-linecap="round"><circle cx="102" cy="92" r="26"/><circle cx="102" cy="92" r="14"/></g><circle cx="102" cy="92" r="4.5" fill="' + W + '"/>' +
      star(168, 40, 10) + star(30, 36, 7) + star(176, 150, 6),

    history:
      '<path d="M26 78 L100 32 L174 78Z" fill="' + K + '"/>' +
      '<circle cx="100" cy="64" r="9" fill="' + W + '"/>' +
      '<rect x="34" y="84" width="132" height="12" rx="3" fill="' + K + '"/>' +
      '<rect x="44" y="102" width="16" height="56" fill="' + K + '"/><rect x="76" y="102" width="16" height="56" fill="' + K + '"/>' +
      '<rect x="108" y="102" width="16" height="56" fill="' + K + '"/><rect x="140" y="102" width="16" height="56" fill="' + K + '"/>' +
      '<g stroke="' + W + '" stroke-width="2.5" stroke-linecap="round"><path d="M52 108V152M84 108V152M116 108V152M148 108V152"/></g>' +
      '<rect x="28" y="158" width="144" height="11" rx="3" fill="' + K + '"/><rect x="18" y="169" width="164" height="11" rx="3" fill="' + K + '"/>',

    ideas:
      '<g stroke="' + K + '" stroke-width="7" stroke-linecap="round">' +
        '<path d="M100 14V28M44 36L54 46M156 36L146 46M24 88H38M162 88H176"/>' +
      '</g>' +
      '<circle cx="100" cy="88" r="46" fill="' + K + '"/>' +
      '<path d="M82 98 L91 80 L100 98 L109 80 L118 98" fill="none" stroke="' + W + '" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M100 98 V122" stroke="' + W + '" stroke-width="4.5" stroke-linecap="round"/>' +
      '<rect x="80" y="134" width="40" height="11" rx="4" fill="' + K + '"/>' +
      '<rect x="84" y="149" width="32" height="11" rx="4" fill="' + K + '"/>' +
      '<rect x="91" y="164" width="18" height="9" rx="4.5" fill="' + K + '"/>',

    science:
      '<circle cx="100" cy="100" r="42" fill="' + K + '"/>' +
      '<path d="M70 92 C86 84 112 84 132 94" fill="none" stroke="' + W + '" stroke-width="3.5" stroke-linecap="round"/>' +
      '<path d="M66 112 C84 106 114 106 138 114" fill="none" stroke="' + W + '" stroke-width="3.5" stroke-linecap="round"/>' +
      '<ellipse cx="100" cy="100" rx="82" ry="22" transform="rotate(-22 100 100)" fill="none" stroke="' + K + '" stroke-width="11"/>' +
      '<ellipse cx="100" cy="100" rx="82" ry="22" transform="rotate(-22 100 100)" fill="none" stroke="' + W + '" stroke-width="4"/>' +
      star(34, 42, 11) + star(166, 40, 8) + star(160, 164, 10) + star(36, 160, 6),

    lives:
      '<circle cx="152" cy="52" r="16" fill="' + W + '" stroke="' + K + '" stroke-width="6"/>' +
      '<path d="M16 168 L80 70 L114 118 L140 88 L184 168Z" fill="' + K + '"/>' +
      '<path d="M80 70 L64 94 L78 88 L90 98Z" fill="' + W + '"/>' +
      '<path d="M80 70 V36" stroke="' + K + '" stroke-width="5" stroke-linecap="round"/>' +
      '<path d="M82 38 L110 48 L82 58Z" fill="' + K + '"/>',

    fiction:
      '<path d="M100 76 C80 62 52 62 28 70 L28 148 C52 140 80 142 100 156Z" fill="' + K + '"/>' +
      '<path d="M100 76 C120 62 148 62 172 70 L172 148 C148 140 120 142 100 156Z" fill="' + K + '"/>' +
      '<g stroke="' + W + '" stroke-width="3" stroke-linecap="round"><path d="M44 88C58 85 72 87 84 92M44 102C58 99 72 101 84 106M44 116C58 113 72 115 84 120M116 92C128 87 142 85 156 88M116 106C128 101 142 99 156 102M116 120C128 115 142 113 156 116"/></g>' +
      '<path d="M40 20 A17 17 0 1 0 60 44 A13 13 0 1 1 40 20Z" fill="' + K + '"/>' +
      star(120, 34, 9) + star(150, 22, 6) + star(168, 46, 8) + star(100, 52, 5),

    crime:
      '<circle cx="86" cy="86" r="48" fill="' + W + '" stroke="' + K + '" stroke-width="12"/>' +
      '<path d="M122 122 L166 166" stroke="' + K + '" stroke-width="18" stroke-linecap="round"/>' +
      '<g fill="none" stroke="' + K + '" stroke-width="4.5" stroke-linecap="round">' +
        '<path d="M60 96 a26 26 0 0 1 52 0"/><path d="M68 98 a18 18 0 0 1 36 0"/><path d="M76 100 a10 10 0 0 1 20 0"/>' +
        '<path d="M60 104 a26 24 0 0 0 20 26"/><path d="M112 104 a26 26 0 0 1 -8 20"/><path d="M68 106 a18 18 0 0 0 10 16"/><path d="M104 106 a18 18 0 0 1 -4 10"/>' +
        '<path d="M86 100 V112"/>' +
      '</g>'
  };

  var GROUPS = [
    { key: 'crime',    name: 'Crime & Thrillers',   bg: '#f28f8f', cats: ['Crime & True Crime', 'Fiction — Thriller'] },
    { key: 'fiction',  name: 'Fiction',             bg: '#6cc4bd', cats: ['Fiction — Literary', 'Fiction — Sci-Fi', 'Fiction — Historical'] },
    { key: 'lives',    name: 'Lives & Adventure',   bg: '#b8a5f3', cats: ['Biography & Memoir', 'Sport'] },
    { key: 'science',  name: 'Science & Nature',    bg: '#86d9b8', cats: ['Science & Technology', 'Nature & Environment'] },
    { key: 'history',  name: 'History & Politics',  bg: '#f2a07b', cats: ['History', 'Politics & Society'] },
    { key: 'business', name: 'Business & Money',    bg: '#f5c04a', cats: ['Business & Entrepreneurship', 'Economics', 'Leadership'] },
    { key: 'mind',     name: 'Mind & Self',         bg: '#f4a3bf', cats: ['Personal Development', 'Psychology', 'Health & Wellbeing', 'Parenting & Family'] },
    { key: 'ideas',    name: 'Big Ideas',           bg: '#8ed2f5', cats: ['Philosophy', 'Spirituality'] }
  ];
  // Order on the home screen (how people browse), separate from the matching order above.
  var DISPLAY = ['business', 'mind', 'ideas', 'history', 'science', 'lives', 'fiction', 'crime'];

  function byKey(k) { for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].key === k) return GROUPS[i]; return GROUPS[GROUPS.length - 1]; }
  // A book belongs to the first group (in GROUPS order) that matches any of its categories.
  function groupFor(cats) {
    cats = cats || [];
    for (var i = 0; i < GROUPS.length; i++)
      for (var j = 0; j < GROUPS[i].cats.length; j++) if (cats.indexOf(GROUPS[i].cats[j]) !== -1) return GROUPS[i].key;
    return 'ideas';
  }
  // svg(key, {slice}) : slice fills the box (covers); default keeps the whole picture.
  function svg(key, o) {
    o = o || {};
    return '<svg viewBox="0 0 200 200" preserveAspectRatio="' + (o.slice ? 'xMidYMid slice' : 'xMidYMid meet') + '" aria-hidden="true" focusable="false">' + (ART[key] || ART.ideas) + '</svg>';
  }
  window.SCENES = { GROUPS: GROUPS, DISPLAY: DISPLAY, byKey: byKey, groupFor: groupFor, svg: svg };
})();
