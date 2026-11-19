import type { IssueView, LookId, UiPanel } from './adapter';
import jynxzi from '../../../../../fixtures/qa/jynxzi.json';

type Beat = readonly [caption: string, dialogue: string];
const stories: Record<string, { title: string; streamTitle: string; channel: string; art: string; beats: Beat[] }> = {
  'tabletop-night': {
    title: 'Critical Mess', streamTitle: 'The dice had other plans', channel: 'juniper_rolls', art: 'tabletop',
    beats: [
      ['At dawn, the citadel beacon is dark.', 'We find the crystal. We get home.'],
      ['Pip finds something under the ivy.', 'A key! Good nose, Pip.'],
      ['The old lock finally turns.', 'Stay close.'],
      ['A golden die guards the empty vault.', 'That was not on the map.'],
      ['Pip catches a scent at the pedestal.', 'You smell a trap?'],
      ['One little roll could open the passage.', 'Just this once.'],
      ['The die skips across the stone.', 'Come on. Anything but one.'],
      ['One. The floor answers first.', 'RUN!'],
      ['The broken floor becomes a slide.', 'Pip! I have you!'],
      ['A hidden garden breaks their fall.', 'We are alive. That counts.'],
      ['Small glowing tracks lead onward.', 'Someone else came this way.'],
      ['The tracks stop beside a sleeping giant.', 'Quiet feet. Very quiet feet.'],
      ['The guardian wakes in front of the exit.', 'We are not here to fight.'],
      ['The explorer lowers the key, not a weapon.', 'Is this yours?'],
      ['Pip spots a familiar shape in its chest.', 'The keyhole! Of course.'],
      ['The key turns. The guardian remembers.', 'You were waiting for help.'],
      ['A stone hand reveals the hidden stair.', 'Thank you, big friend.'],
      ['They carry the lost crystal into daylight.', 'Nearly home, Pip.'],
      ['The beacon shines across the valley.', 'There. Everyone can find the way.'],
      ['By the fire, even heroes need a rest.', 'Next adventure: fewer dice.'],
    ],
  },
  'speedrun-fail': {
    title: 'Frame Perfect', streamTitle: 'One jump from glory', channel: 'orbit_runs', art: 'speedrun',
    beats: [
      ['The sky-city course opens at sunrise.', 'Today we finish together.'],
      ['Orbit and Bit trace the last shortcut.', 'Here. That is where we save time.'],
      ['One last check of the laces.', 'No excuses, little robot.'],
      ['The start light flashes.', 'GO!'],
      ['The first platforms fly beneath her feet.', 'Easy rhythm.'],
      ['Clock towers become stepping stones.', 'Keep up, Bit!'],
      ['Bit finds a gap in the old route.', 'You clever little shortcut.'],
      ['Orbit slips through the narrow arch.', 'Made it!'],
      ['The finish is one leap away.', 'We are actually doing this.'],
      ['A loose tile tips beneath her shoe.', 'Wait—'],
      ['The ledge disappears behind her.', 'BIT!'],
      ['A small metal hand catches her sleeve.', 'I have you.'],
      ['Back at the gate, the timer resets.', 'So much for perfect.'],
      ['They study the mistake together.', 'Fast is useless if we fall.'],
      ['One careful step. Then another.', 'Find the solid tile.'],
      ['The gate opens for a second attempt.', 'Ready when you are.'],
      ['This time, the difficult jump holds.', 'THAT is the one!'],
      ['They race the last bridge side by side.', 'Together, Bit!'],
      ['The finish lights burst into colour.', 'We did it!'],
      ['Above the city, the trophy is shared.', 'Best time? Best teammate.'],
    ],
  },
  'irl-cooking': {
    title: 'Batter Days', streamTitle: 'Breakfast, probably', channel: 'clover_cooks', art: 'cooking',
    beats: [
      ['Clover opens the kitchen for breakfast.', 'Pancakes. How hard can it be?'],
      ['Berries, eggs, flour. One curious cat.', 'Ingredients are not toys, Marmalade.'],
      ['The recipe looks reassuringly short.', 'We can do short.'],
      ['Everything gets measured twice.', 'A little patience.'],
      ['The batter begins to come together.', 'Smooth enough?'],
      ['Marmalade inspects the mixing bowl.', 'Quality control has arrived.'],
      ['A paw meets the flour bag.', 'Oh no.'],
      ['For a moment, the kitchen is a cloud.', 'Very funny, chef.'],
      ['The first pancake meets the pan.', 'Now for the impressive part.'],
      ['A confident flip sends it flying.', 'Too impressive!'],
      ['Breakfast lands somewhere unexpected.', 'A pancake hat. Naturally.'],
      ['Marmalade offers a silent review.', 'Yes. I saw the look.'],
      ['They clear the counter and try again.', 'Breakfast deserves a second chance.'],
      ['Less heat. More patience.', 'Let the edges set.'],
      ['A gentle flip lands perfectly.', 'There we go.'],
      ['Three golden pancakes make a stack.', 'We have a breakfast!'],
      ['Berries turn it into a celebration.', 'One finishing touch.'],
      ['Marmalade returns the missing strawberry.', 'Peace offering accepted.'],
      ['Friends arrive just as the plates come out.', 'You are right on time.'],
      ['At last, the chefs sit down together.', 'Tomorrow, toast.'],
    ],
  },
};

/** Background pockets reviewed against the original scene sheets. Palette variants preserve composition. */
const bubblePockets: Record<string, number[][]> = {
  tabletop: [[3,3,43,22],[60,3,37,23],[3,74,40,23],[3,3,38,22],[3,3,38,20],[54,74,43,23],[57,3,40,23],[59,74,38,23],[61,3,36,22],[60,3,37,23],[59,74,38,23],[3,3,39,23],[59,74,38,23],[3,3,39,23],[3,76,40,21],[3,75,41,22],[58,3,39,22],[3,3,39,22],[3,3,36,22],[60,3,37,23]],
  speedrun: [[3,3,34,23],[3,74,36,23],[66,3,31,23],[3,74,34,23],[60,74,37,23],[3,74,40,23],[60,74,37,23],[3,3,34,23],[3,3,35,23],[64,74,33,23],[3,74,40,23],[3,3,40,23],[66,3,31,23],[3,74,36,23],[3,3,35,23],[3,74,34,23],[3,74,45,23],[3,3,35,23],[66,3,31,23],[3,3,40,23]],
  cooking: [[3,75,33,22],[3,3,33,23],[67,3,30,24],[3,75,32,22],[66,3,31,23],[3,3,34,23],[66,3,31,23],[3,3,34,23],[3,3,35,23],[3,74,35,23],[66,3,31,23],[3,76,35,21],[3,3,34,23],[3,3,34,23],[3,3,34,23],[3,75,34,22],[69,3,28,23],[62,77,35,20],[3,77,35,20],[66,3,31,23]],
};
function sampleBubble(art: string, index: number) {
  const [x,y,width,height] = bubblePockets[art]![index]!;
  return { x: x!, y: y!, width: width!, height: height! };
}

function sceneSize(art: string, index: number) {
  const rows = art === 'tabletop' ? [0,198,397,608,806,1052] : art === 'speedrun' ? [0,210,414,620,821,1052] : [0,201,395,590,787,1052];
  const row = Math.floor(index / 4);
  const sourceWidth = art === 'tabletop' ? 1494 : art === 'speedrun' ? 1495 : 1496;
  const sourceHeight = art === 'cooking' ? 1051 : 1052;
  return { width: sourceWidth * (.25 - .006), height: sourceHeight * ((rows[row + 1]! - rows[row]!) / 1052 - .006) };
}

/** Authored Sample fiction: one complete five-page episode, shared by reader and collected book. */
export function sampleStoryIssue(id: string, look: LookId): IssueView {
  if(id==='sample-jynxzi-qa'){
    const rows=[134,546,946,1472].map(n=>n/1536),cols=[12,518,1014].map(n=>n/1024);
    const panels:UiPanel[]=jynxzi.panels.map((caption,index)=>({
      id:`sample-jynxzi-qa-${index}`,origin:'sample',caption,dialogue:index===3?[jynxzi.source.text]:[],
      altText:`Chat-inspired QA interpretation, panel ${index+1}: ${caption}`,imageUrl:jynxzi.art.festival,
      art:{width:1024*(cols[index%2+1]!-cols[index%2]!-.006),height:1536*(rows[Math.floor(index/2)+1]!-rows[Math.floor(index/2)]!-.006),tone:'colour',
        lettered:index!==3,replaceBubble:index===3,bubbleLabel:'Chat',bubble:index===3?{x:9,y:8,width:52,height:46}:undefined,
        atlas:{columns:2,rows:3,cell:index,rowEdges:rows,colEdges:cols},themes:jynxzi.art},
      source:'generated',generatedCaption:true,at:index*15,provenance:{provider:'sample-qa',asset:'jynxzi-qa',style:'comic',fallback:false}
    }));
    return {id,title:jynxzi.title,streamTitle:jynxzi.streamTitle,channel:jynxzi.channel,panels,storyPanels:panels,sample:true,look};
  }
  const key = id.replace(/^sample-/, '');
  const story = stories[key];
  if (!story) throw new Error(`There is no Sample story called ${id}.`);
  const storyPanels: UiPanel[] = story.beats.map(([caption, line], index) => ({
    id: `sample-story-${key}-${index}`, origin: 'sample', caption, dialogue: [line],
    altText: `${story.title}, scene ${index + 1}: ${caption}`,
    imageUrl: `/samples/stories/${story.art}-festival.png`,
    art: { ...sceneSize(story.art, index), tone: 'colour', bubble: sampleBubble(story.art, index),
      atlas: { columns: 4, rows: 5, cell: index, rowEdges: (story.art === 'tabletop' ? [0,198,397,608,806,1052] : story.art === 'speedrun' ? [0,210,414,620,821,1052] : [0,201,395,590,787,1052]).map(y => y / 1052) },
      themes: Object.fromEntries(['festival', 'sunset', 'lagoon', 'blossom'].map(theme => [theme, `/samples/stories/${story.art}-${theme}.png`])) as Record<LookId, string>,
    },
    source: 'generated', generatedCaption: false, at: index * 60,
    provenance: { provider: 'library', asset: `${story.art}-festival.png`, style: 'risograph', fallback: false },
  }));
  return { id, title: story.title, streamTitle: story.streamTitle, channel: story.channel,
    panels: storyPanels, storyPanels, sample: true, look };
}

/** Theme changes select painted art; they never recolour skin or objects with a global filter. */
export function panelArtUrl(panel: Pick<UiPanel, 'imageUrl' | 'art'>, look: LookId): string {
  return panel.art.themes?.[look] ?? panel.imageUrl;
}

/** Measured scene boundaries, inset slightly to exclude the atlas seams. Shared by HTML and PNG. */
export function panelArtRect(panel: Pick<UiPanel, 'art'>): [number, number, number, number] {
  const atlas = panel.art.atlas;
  if (!atlas) return [0, 0, 1, 1];
  const row = Math.floor(atlas.cell / atlas.columns);
  const y = atlas.rowEdges?.[row] ?? row / atlas.rows;
  const bottom = atlas.rowEdges?.[row + 1] ?? (row + 1) / atlas.rows;
  const inset = .003;
  const col=atlas.cell%atlas.columns,x=atlas.colEdges?.[col]??col/atlas.columns;
  const right=atlas.colEdges?.[col+1]??(col+1)/atlas.columns;
  return [x+inset,y+inset,right-x-inset*2,bottom-y-inset*2];
}
