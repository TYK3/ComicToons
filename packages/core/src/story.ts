/** Original, explicitly invented sample stories. Live chat is never invented here. */
export interface StoryBeat {
  frame: number;
  imageUrl: string;
  scene: string;
  dialogue: string[];
  sfx?: string;
  climax?: boolean;
}
export interface StoryAtlas { frame: number; columns: number; rows: number }
export const sampleStories = {
  'tabletop-night': {
    asset: 'tabletop',
    scenes: ['Juniper and Pixel enter the crystal vault.', 'Pixel runs off with the vault key.', 'A crystal guardian wakes behind Juniper.', 'Juniper bets everything on one roll.', 'The roll opens the vault. The party is safe.', 'Pixel returns the key as new friends arrive.'],
    speech: ['We made it. Where is the key?', 'Pixel! Drop the key!', 'Nobody move. I think it heard us.', 'One roll. Please work...', 'YES! The vault is open!', 'Next time, YOU carry the key.'],
    chat: ['This place is HUGE.', 'The fox has the key!!', 'Behind you. BEHIND YOU!', 'We believe. Roll it!', 'NAT TWENTY! WE LIVED!', 'New crew, same chaos.'],
    effects: ['', 'ZIP!', '', 'CLACK', 'KRA-KOOM!', ''],
  },
  'speedrun-fail': {
    asset: 'speedrun',
    scenes: ['Orbit studies the final clockwork platform.', 'Orbit misses the shortcut jump.', 'Orbit clings to the ledge, stunned.', 'Orbit and Pip line up one last attempt.', 'Orbit clears the gap and reaches the finish.', 'Orbit catches their breath while Pip celebrates.'],
    speech: ['One clean jump. That is all we need.', 'Wait. That platform MOVES?!', 'I meant to do that. Obviously.', 'Okay. One more try. Together.', 'LANDED! Stop the clock!', 'Never doubted us. Not even a little.'],
    chat: ['PB pace. Nobody breathe.', 'NOOO THE SHORTCUT!', 'New scenic route unlocked.', 'Reset the nerves. You got this.', 'THAT IS THE RUN!', 'We all aged ten years.'],
    effects: ['', 'WHIFF!', '', '', 'WHOOSH!', ''],
  },
  'irl-cooking': {
    asset: 'cooking',
    scenes: ['Clover mixes pancake batter as Miso watches.', 'Clover attempts an ambitious pancake flip.', 'The pancake sticks to the range hood.', 'Clover steadies the pan for a second attempt.', 'The pancake lands perfectly in the pan.', 'Clover shares the finished pancake celebration with Miso.'],
    speech: ['Easy recipe. What could possibly go wrong?', 'Watch this. Chef technique.', '...That is not a plate.', 'Smaller flip. Bigger belief.', 'Breakfast is SAVED!', 'Same time tomorrow? Bring a helmet.'],
    chat: ['Miso is supervising.', 'That is a LOT of airtime.', 'Ceiling pancake. Five stars.', 'We believe in the comeback.', 'CHEF CLOVER! CHEF CLOVER!', 'Worth every chaotic minute.'],
    effects: ['', 'FWOOP!', '', '', 'PAT!', ''],
  },
} as const;

export function sampleStory(id: string) {
  return Object.prototype.hasOwnProperty.call(sampleStories, id) ? sampleStories[id as keyof typeof sampleStories] : undefined;
}
