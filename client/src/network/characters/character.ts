import GUID from "../game/guid";

class Character {
  guid?: GUID;
  name: string = '';
  class: string ='';
  equipment: {
    model: number, 
    type: number, 
    enchantment: number
  }[] = [];

  facial?: number;
  flags?: number;
  gender?: number;
  guild?: number;
  level?: number;
  map?: number;
  race?: number;
  x?: number;
  y?: number;
  z?: number;
  zone?: number;


  // Short string representation of this character
  toString() {
    return `[Character; GUID: ${this.guid}]`;
  }

}

export default Character;