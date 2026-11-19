/** Original ComicToons vector scenes. No external assets, text, fonts, or likenesses. */
export const artScenes = [
  { scene: 'The crystal vault', altText: 'A small scarf-wearing explorer approaches a towering open crystal vault. Light spills across the cavern floor.', sfx: 'CREAK', bubblePlacement: 'top-left' },
  { scene: 'The familiar and the key', altText: 'Close-up of a mischievous teal familiar leaping away with a gold key, its long tail curling across a pink burst background.', sfx: 'YOINK', bubblePlacement: 'top-right' },
  { scene: 'The impossible roll', altText: 'A dramatic foreshortened gloved hand releases a large tumbling die across a blue tabletop, surrounded by motion rays.', sfx: 'CLATTER', bubblePlacement: 'top-left' },
  { scene: 'The victory party', altText: 'Three original adventurers raise their hands around a glowing crystal trophy as colorful confetti falls.', sfx: 'HUZZAH', bubblePlacement: 'top-right' },
  { scene: 'The leap of faith', altText: 'An explorer with a flowing red scarf leaps over a deep gap between floating platforms beneath an enormous yellow moon.', sfx: 'WHOOSH', bubblePlacement: 'bottom-left' },
  { scene: 'The pancake comeback', altText: 'A chef explorer flips a golden pancake high above a frying pan in a tiled midnight kitchen; a small familiar watches from the counter.', sfx: 'FLIP', bubblePlacement: 'top-left' },
] as const;

export function artComposition(index: number): number { return ((Math.floor(index) % artScenes.length) + artScenes.length) % artScenes.length; }

export function mockArtSvg(index: number, style = 'risograph'): string {
  const composition = artComposition(index);
  const noir = style === 'noir';
  const ink = '#171c2c';
  const paper = noir ? '#e9e3d6' : '#fff0cb';
  const gold = noir ? '#d5cdb8' : '#f3bd41';
  const red = noir ? '#797e89' : '#ef624e';
  const teal = noir ? '#a0a7aa' : '#65b9ad';
  const blue = noir ? '#555e6d' : '#668dc7';
  const backgrounds = noir ? ['#9da4ad', '#6f7885', '#b5b5b0', '#818992', '#4a5366', '#a9aaa4'] : ['#e8bc70', '#eea8b0', '#8eafd7', '#a7c6ba', '#7485b8', '#e5bb87'];
  const outlines = `stroke="${ink}" stroke-width="9" stroke-linejoin="round" stroke-linecap="round"`;
  const star = (x: number, y: number, size = 24, color = paper) => `<path d="M${x} ${y-size}l${size*.23} ${size*.7} ${size*.77} ${size*.3}-${size*.77} ${size*.25}-${size*.23} ${size*.75}-${size*.25}-${size*.75}-${size*.75}-${size*.25} ${size*.75}-${size*.3}z" fill="${color}"/>`;
  const eyes = (x: number, y: number) => `<ellipse cx="${x}" cy="${y}" rx="7" ry="12" fill="${paper}"/><ellipse cx="${x+32}" cy="${y}" rx="7" ry="12" fill="${paper}"/>`;
  const rays = `<g stroke="${paper}" stroke-width="12" opacity=".55"><path d="M0 30 300 230M145 0 355 205M800 0 530 220M800 145 565 285M800 550 550 390M0 550 300 390M400 600V435"/></g>`;
  // Each composition has different staging, silhouette, pose, scale, and environment.
  const scenes = [
    `<path d="M0 0h215l-65 205 70 118-87 277H0zM800 0H635l40 167-65 140 66 293h124" fill="${ink}" opacity=".87"/>
     <g ${outlines}><path d="M279 469V181L427 55l154 126v288z" fill="${blue}"/><path d="M318 467V202l109-96 111 96v265" fill="${ink}"/><path d="m427 106 111 96v265l-111-44z" fill="${gold}"/><path d="m318 202 109-96v317l-109 44z" fill="${paper}"/><path d="m318 467-161 133h548L538 467" fill="${gold}"/><path d="m427 423-17 177M332 493l-39 107M508 493l56 107" fill="none" opacity=".4"/>
     <path d="m660 468-29-117 38-67 47 87-8 97zM103 477l-12-65 29-40 33 58-10 47" fill="${teal}"/>
     <ellipse cx="351" cy="536" rx="81" ry="18" fill="${ink}" opacity=".2" stroke="none"/>
     <path d="m321 489-12 76h31l17-60 12 60h34l-16-85" fill="${ink}"/><path d="M307 481v-61q0-48 44-48t46 48v61z" fill="${paper}"/><circle cx="352" cy="350" r="48" fill="${paper}"/><path d="M313 345q39-50 78 0v26h-78z" fill="${ink}"/><path d="m310 399 88-13 2 29-78 10-40 37-19-20z" fill="${red}"/><path d="m397 434 36-23 12 20-46 32" fill="${paper}"/></g>${star(564,86,19)}${star(239,260,13)}`,
    `${rays}<ellipse cx="390" cy="535" rx="278" ry="31" fill="${ink}" opacity=".14"/>
     <g ${outlines}><path d="M276 398C104 457 96 218 204 240c-56-9-66 107 62 72" fill="${teal}"/><path d="M278 289c80-115 225-62 233 46l83 50-28 37-98-32-98 71-76-18 41-55-93-18z" fill="${teal}"/><path d="m325 248-49-100 95 48M410 202l88-51-23 118" fill="${teal}"/><path d="m321 244-20-51 47 26M436 220l35-26-13 49" fill="${red}" stroke-width="5"/><path d="M307 268q81-91 173 1l-25 84-77 35-79-52z" fill="${teal}"/><path d="m334 285 29-7m60-3 25 12" fill="none"/><ellipse cx="350" cy="306" rx="9" ry="15" fill="${ink}" stroke="none"/><ellipse cx="432" cy="306" rx="9" ry="15" fill="${ink}" stroke="none"/><path d="m380 326 20 1-10 13z" fill="${ink}"/><path d="m358 350 26 14 44-23" fill="none" stroke-width="5"/><path d="m466 350 97-48 15 24-88 66" fill="${teal}"/>
     <g transform="rotate(24 568 299)"><circle cx="572" cy="257" r="35" fill="${gold}"/><circle cx="572" cy="257" r="13" fill="${backgrounds[1]}" stroke-width="6"/><path d="M561 290v119h36v-24h22v-25h-24v-70" fill="${gold}"/></g><path d="m282 420-51 22 5 28 79-26M423 422l-10 49 45 7 29-66" fill="${teal}"/></g>
     <g stroke="${ink}" stroke-width="6"><path d="m126 333-51 5m74-51-36-17m456 174 39 15m-4-51 43 3"/></g>${star(633,195,35,gold)}${star(193,126,20)}${star(666,464,22)}`,
    `${rays}<path d="M0 464 800 285v315H0" fill="${blue}"/><path d="m0 514 800-177M67 600l434-232" stroke="${ink}" stroke-width="6" opacity=".3"/>
     <g ${outlines}><path d="M-46 570 93 353l78-55 103 5 86 65-31 42-69-31-22 11 84 50 78 13 28 36-25 29-118-11-84-28-49 121" fill="${paper}"/><path d="m79 392 68 53-56 115-103-45z" fill="${red}"/><path d="m130 357 54 40m21-52 57 31m-36 38 55 27" fill="none" stroke-width="5"/>
     <g transform="rotate(-17 515 295)"><path d="m408 194 183-23 65 120-124 116-137-89z" fill="${paper}"/><path d="m408 194 124 86 59-109M532 280v127M532 280l124 11" fill="none"/><path d="m441 238 63 42-45 36-38-26z" fill="${red}" stroke="none"/><ellipse cx="576" cy="238" rx="12" ry="17" fill="${ink}" stroke="none"/><ellipse cx="586" cy="320" rx="11" ry="17" fill="${ink}" stroke="none"/><ellipse cx="620" cy="296" rx="10" ry="15" fill="${ink}" stroke="none"/></g>
     <path d="m353 174 43-47m-4 82 59-38m160 221 44 36m-7-67 61 20" fill="none" stroke-width="7"/></g>${star(648,157,24,gold)}${star(326,255,19)}${star(705,470,18)}`,
    `<circle cx="413" cy="275" r="198" fill="${gold}"/><circle cx="413" cy="275" r="162" fill="url(#dots)"/><path d="M0 513q400-94 800 0v87H0" fill="${blue}"/>
     <g ${outlines}><path d="M61 600v-164q0-67 84-67t88 67v164" fill="${teal}"/><path d="m73 436-49-123 29-17 63 100M208 423l46-130 34 12-35 151" fill="${teal}"/><circle cx="145" cy="326" r="67" fill="${teal}"/><path d="m95 273-3-51 48 41m41 5 39-39-3 65" fill="${teal}"/><path d="m109 325 18-12m37-1 19 12m-60 23q23 23 45-1" fill="none" stroke-width="6"/>
     <path d="M276 600V413q0-77 102-77t100 77v187" fill="${paper}"/><path d="m292 420-72-102 27-23 88 95m117 26 68-116-29-18-83 94" fill="${paper}"/><circle cx="379" cy="269" r="78" fill="${paper}"/><path d="M315 257q64-67 128 0v50H315z" fill="${ink}"/>${eyes(363,275)}<path d="m305 350 153-16-9 41-139 16 40 54-45 9-32-57z" fill="${red}"/>
     <path d="M551 600V448q0-73 80-73t87 73v152" fill="${red}"/><path d="m564 436-48-100 27-16 63 88m89 24 57-113 26 15-34 130" fill="${red}"/><path d="M568 345v-59q65-80 129 0v59z" fill="${gold}"/><path d="M585 299h95v43h-95z" fill="${ink}"/>${eyes(612,319)}
     <path d="m342 541 36-80 55 10 28 74-61 33z" fill="${gold}"/><path d="m378 461 22 117 33-107M342 541l119 4" fill="none" stroke-width="5"/></g>
     <g fill="${red}"><path d="m96 117 16-18 22 25-17 16zM570 127l23-15 14 31-24 10zM741 245l25 9-11 28-22-6z"/></g><g fill="${blue}"><path d="m242 166 21-15 13 24-18 16zM476 73l16-21 23 20-18 21zM60 219l20-4 7 26-22 5z"/></g>${star(327,127,20)}${star(691,153,23)}`,
    `<circle cx="574" cy="213" r="144" fill="${gold}"/><circle cx="574" cy="213" r="115" fill="url(#dots)"/><path d="m0 386 168-58 104 82 72 190H0m800-294-133 84-60 210h193" fill="${ink}"/><path d="m0 386 168-58 66 54-148 56zM667 390l133-84v68l-139 80" fill="${teal}" ${outlines}/><path d="M0 542 138 500l89 100H0M685 533l115-35v102H664" fill="${blue}"/>
     <g ${outlines}><path d="m322 359-83 88-44-2-25 36 100 13 97-91m53-43 51 66 111-20 8 41-139 27-85-74" fill="${paper}"/><path d="m194 447-48 16-8 43 95 4 37-16M551 408l50-14 38 28-49 25" fill="${ink}"/><path d="m306 296 74-35 77 66-66 83-91-55z" fill="${paper}"/><path d="m304 310-64 18-48-70-29 19 41 99 110-19M416 312l81-39 44-77-29-18-53 60-82 30" fill="${paper}"/><circle cx="379" cy="218" r="65" fill="${paper}"/><path d="M327 211q51-53 104 0v38H327z" fill="${ink}"/>${eyes(361,225)}<path d="m326 273 119-23 4 33-110 25-116-77-72 13 23-48 75 5z" fill="${red}"/>
     <path d="m185 387-92-15m92-32-112-31m398 185 70 19m-82-53 83 20" stroke="${paper}" stroke-width="6" fill="none"/></g>${star(679,103,22)}${star(100,180,21)}${star(631,490,17)}`,
    `<path d="M0 190h800v410H0" fill="${teal}"/><g stroke="${paper}" stroke-width="4" opacity=".5"><path d="M0 270h800M0 350h800M0 430h800M80 190v280M180 190v280M280 190v280M380 190v280M480 190v280M580 190v280M680 190v280M780 190v280"/></g><path d="M0 484h800v116H0" fill="${blue}"/><path d="M0 485h800" stroke="${ink}" stroke-width="12"/>
     <g ${outlines}><path d="M91 493V342q0-57 93-57t94 57v151" fill="${paper}"/><path d="m97 382-54 72 25 27 70-62m126-48 89 41 57-48 23 26-64 69-105-32" fill="${paper}"/><circle cx="182" cy="234" r="65" fill="${paper}"/><path d="M129 235q52-44 106 0v35H129z" fill="${ink}"/>${eyes(163,245)}<path d="M127 191v-28q-34-36-5-62 24-19 48 5 21-38 50-17 15 11 9 31 44-6 46 28 0 28-37 30v22z" fill="${paper}"/><path d="m130 306 110-11 1 25-102 13" fill="${red}"/><path d="M146 349h86l24 141H120z" fill="${red}"/>
     <path d="m388 389 111-10" stroke-width="21"/><path d="M474 367q103 73 213-4l-15 39q-93 62-178 0z" fill="${ink}"/><path d="M478 367q108 48 210-4" fill="none"/>
     <ellipse cx="581" cy="202" rx="98" ry="27" transform="rotate(-22 581 202)" fill="${gold}"/><path d="M493 214q92 22 177-66" fill="none" stroke-width="5"/><path d="M517 308q-14-38 14-58M663 283q33-31 23-72" fill="none" stroke="${paper}" stroke-width="8"/>
     <path d="M642 482q-25-48 10-71l-5-43 41 28 45-19-9 45q29 45-4 60" fill="${teal}"/><circle cx="674" cy="436" r="5" fill="${ink}"/><circle cx="705" cy="432" r="5" fill="${ink}"/><path d="m686 452 10 0-5 7" fill="${ink}"/><path d="M40 530h104v70H40M678 529h83v71h-83" fill="${paper}"/></g>${star(697,134,22)}${star(431,249,19,gold)}`,
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><defs><pattern id="dots" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.65" fill="${ink}" opacity=".19"/></pattern><pattern id="grain" width="31" height="23" patternUnits="userSpaceOnUse"><path d="m2 4 3 1m17 11 2-1m-15 5 1 2" stroke="${ink}" stroke-width="1" opacity=".12"/></pattern></defs><path d="M0 0h800v600H0z" fill="${backgrounds[composition]}"/><path d="M0 0h800v600H0z" fill="url(#dots)"/>${scenes[composition]}<path d="M0 0h800v600H0z" fill="url(#grain)"/></svg>`;
}

export function mockArt(index: number, style = 'risograph'): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(mockArtSvg(index, style))}`;
}
