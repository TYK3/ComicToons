/** Freeze isolated layout and paint text with verified browser FontFaces before
 * SVG composition. SVG image documents cannot be trusted to load web fonts. */
function textBitmap(element:HTMLElement,style:CSSStyleDeclaration):string|undefined {
  if(element.children.length||!element.textContent?.trim()||style.display==='none'||style.visibility==='hidden'||['STYLE','SCRIPT'].includes(element.tagName))return;
  const transform=element.style.transform;
  element.style.setProperty('transform','none','important');
  try{
    const bounds=element.getBoundingClientRect();if(bounds.width<=2||bounds.height<=2)return;
    const canvas=document.createElement('canvas');canvas.width=Math.ceil(bounds.width*2);canvas.height=Math.ceil(bounds.height*2);
    const context=canvas.getContext('2d')!;context.scale(2,2);
    const family=style.fontFamily.includes('Barlow')?'ComicToonsExportDisplay':'ComicToonsExportBody';
    context.font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} "${family}", sans-serif`;
    context.fillStyle=style.color;context.direction=style.direction==='rtl'?'rtl':'ltr';context.textAlign=context.direction==='rtl'?'right':'left';
    context.letterSpacing=style.letterSpacing==='normal'?'0px':style.letterSpacing;
    const shadow=/^(rgba?\([^)]+\)) ([-\d.]+)px ([-\d.]+)px ([-\d.]+)px$/.exec(style.textShadow);
    if(shadow){context.shadowColor=shadow[1]!;context.shadowOffsetX=Number(shadow[2]);context.shadowOffsetY=Number(shadow[3]);context.shadowBlur=Number(shadow[4]);}
    const lines=new Map<number,{text:string;left:number;right:number;top:number;height:number}>();
    const node=element.firstChild;if(!node||node.nodeType!==3)return;
    const range=element.ownerDocument.createRange();
    for(const part of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(node.textContent!)){
      range.setStart(node,part.index);range.setEnd(node,part.index+part.segment.length);
      const rect=range.getBoundingClientRect();if(!rect.width||!rect.height)continue;
      const key=Math.round(rect.top*4)/4;let line=lines.get(key);
      if(!line){line={text:'',left:rect.left,right:rect.right,top:rect.top,height:rect.height};lines.set(key,line);}
      line.text+=part.segment;line.left=Math.min(line.left,rect.left);line.right=Math.max(line.right,rect.right);
    }
    for(const line of lines.values()){
      const text=style.textTransform==='uppercase'?line.text.toLocaleUpperCase():line.text;
      const metrics=context.measureText(text);const ascent=metrics.fontBoundingBoxAscent;const descent=metrics.fontBoundingBoxDescent;
      const x=(context.direction==='rtl'?line.right:line.left)-bounds.left;
      const y=line.top-bounds.top+(line.height-ascent-descent)/2+ascent;
      const stroke=Number.parseFloat(style.getPropertyValue('-webkit-text-stroke-width'));
      if(stroke){context.lineWidth=stroke;context.strokeStyle=style.getPropertyValue('-webkit-text-stroke-color');context.strokeText(text,x,y);}
      context.fillText(text,x,y);
    }
    return canvas.toDataURL('image/png');
  }finally{if(transform)element.style.transform=transform;else element.style.removeProperty('transform');}
}

export function freezePngSheet(sheet:HTMLElement,view:Window):HTMLElement {
  const clone=sheet.cloneNode(true) as HTMLElement;
  const sources=[sheet,...sheet.querySelectorAll<HTMLElement>('*')];
  const copies=[clone,...clone.querySelectorAll<HTMLElement>('*')];
  for(let index=0;index<sources.length;index++){
    const source=sources[index]!;const target=copies[index]!;const style=view.getComputedStyle(source);
    for(const property of style)target.style.setProperty(property,style.getPropertyValue(property));
    const bitmap=textBitmap(source,style);
    if(bitmap){
      target.style.backgroundImage=`url("${bitmap}")${style.backgroundImage==='none'?'':`,${style.backgroundImage}`}`;
      target.style.backgroundSize='100% 100%';target.style.backgroundRepeat='no-repeat';target.style.backgroundOrigin='border-box';target.style.backgroundClip='border-box';
      target.style.color='transparent';target.style.setProperty('-webkit-text-fill-color','transparent');target.style.setProperty('-webkit-text-stroke-color','transparent');target.style.textShadow='none';
    }
  }
  return clone;
}
