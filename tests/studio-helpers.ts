// Studio modules are plain browser ES modules (no types, no build). Load them untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Mod = any;
export const studio = (name: string): Promise<Mod> => import(`../public/js/studio/${name}.js`);

/** A hand-written film in the shape the legacy editor saves (see public/js/studio/FORMAT.md). */
export const LEGACY_FILM = `<?xml version="1.0" encoding="utf-8"?>
<film copyable="0" duration="9" published="0"><meta><title><![CDATA[Legacy & Co <test>]]></title><hasWatermark>0</hasWatermark><tag/><mver>2</mver></meta>
<scene id="SCENE-0" adelay="72" mdelay="0"><bg id="BG-0" index="0"><file>common.Diner_bg.swf</file></bg>
<char id="CHARACTER-1" index="3"><action>common.matchBoyNew.stand.swf</action><x>320.5</x><y>300</y><xscale>1.1</xscale><yscale>1.1</yscale><face>1</face><rotation>0</rotation><head><file>common.head.swf</file></head></char>
<prop id="PROP-2" index="1"><file>common.02bat.swf</file><x>10</x><y>20</y><xscale>0.7</xscale><yscale>0.35</yscale><face>-1</face><rotation>15</rotation></prop>
<effectAsset id="EFFECT-3" index="4"><file>common.spray.swf</file><x>100</x><y>100</y></effectAsset>
<bubbleAsset id="BUBBLE-4" index="5"><x>200</x><y>50</y><bubble x="-90" y="-45" w="180" h="90" rotate="0" type="ELLIPSE" hasTail="1"><body rgb="0xFFFFFF" tailx="90" taily="65"/><text rgb="0" font="Lato" size="20" align="center">Hi &amp; bye</text></bubble></bubbleAsset>
<weird a="1"><k/></weird><trans><file>common.fade.swf</file></trans></scene>
<scene id="SCENE-1" adelay="144"><bg id="BG-5"><file>common.court_bg_v1.swf</file></bg><char id="CHARACTER-6"><action>cc2.xml</action><x>100</x><y>200</y></char></scene>
<sound id="SOUND-0"><sfile>ugc.abc.mp3</sfile><start>0</start><stop>96</stop><trimStart>0</trimStart><trimEnd>96</trimEnd><fadein dur="1" vol="2"/><fadeout dur="1" vol="2"/><ttsdata><text><![CDATA[hello there]]></text><voice>kate</voice></ttsdata></sound>
<sound id="SOUND-1"><sfile>common.roadSide.swf</sfile><start>24</start><stop>200</stop></sound>
<asset id="abc.mp3">AAAA</asset><cc_char file_name='ugc.char.C-0-1.xml' xscale='1'><color r="ccSkinColor">0xFFCE95</color></cc_char><thumb>QUJD</thumb></film>`;
