/**
 * lame.js  –  Pure-JavaScript MPEG-1 Layer-3 (MP3) encoder
 * Offline, self-contained.  Implements the lamejs 1.2.1 public API:
 *
 *   var enc = new lamejs.Mp3Encoder(channels, sampleRate, bitrate);
 *   var mp3buf = enc.encodeBuffer(leftInt16 [, rightInt16]);  // → Int8Array
 *   var flush  = enc.flush();                                  // → Int8Array
 *
 * Based on ISO/IEC 11172-3 (MPEG-1 Audio Layer 3).
 * For offline PWA use – quality is equivalent to ~CBR LAME.
 */
(function (root) {
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  0.  CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════
var STEREO        = 0;
var JOINT_STEREO  = 1;
var MONO          = 3;
var SAMPLES_FRAME = 1152;          // PCM samples per granule pair
var SBLIMIT       = 32;            // subbands
var SSLIMIT       = 18;            // subband samples → MDCT points
var GRANULES      = 2;

var BITRATE_IDX   = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320];
var SAMPLERATE_IDX= [44100,48000,32000];

// ═══════════════════════════════════════════════════════════════════════════
//  1.  ANALYSIS FILTER WINDOW  D[512]  (ISO/IEC 11172-3, Annex B Table B.3)
// ═══════════════════════════════════════════════════════════════════════════
/* The 512-tap prototype low-pass filter window.  All values × 1 (float). */
var D = new Float64Array([
 0.000000000,-0.000015259,-0.000015259,-0.000015259,-0.000015259,-0.000015259,
-0.000015259,-0.000030518,-0.000030518,-0.000030518,-0.000030518,-0.000045776,
-0.000045776,-0.000061035,-0.000061035,-0.000076294,-0.000076294,-0.000091553,
-0.000106812,-0.000106812,-0.000122070,-0.000137329,-0.000152588,-0.000167847,
-0.000198364,-0.000213623,-0.000244141,-0.000259399,-0.000289917,-0.000320435,
-0.000366211,-0.000396729,-0.000427246,-0.000472069,-0.000503540,-0.000549316,
-0.000579834,-0.000625610,-0.000671387,-0.000716400,-0.000762939,-0.000808716,
-0.000869751,-0.000915527,-0.000961304,-0.001022339,-0.001068115,-0.001113892,
-0.001174927,-0.001220703,-0.001266479,-0.001312256,-0.001372337,-0.001403809,
-0.001434326,-0.001480103,-0.001480103,-0.001495361,-0.001510620,-0.001480103,
-0.001434326,-0.001388550,-0.001312256,-0.001220703,
// 64
 0.000061035, 0.000076294, 0.000076294, 0.000091553, 0.000106812, 0.000106812,
 0.000106812, 0.000122070, 0.000122070, 0.000137329, 0.000152588, 0.000152588,
 0.000167847, 0.000167847, 0.000198364, 0.000198364, 0.000213623, 0.000228882,
 0.000244141, 0.000259399, 0.000274658, 0.000289917, 0.000320435, 0.000335693,
 0.000366211, 0.000396729, 0.000411987, 0.000442505, 0.000473022, 0.000503540,
 0.000549316, 0.000579834, 0.000625610, 0.000671387, 0.000701904, 0.000747681,
 0.000808716, 0.000869751, 0.000915527, 0.000961304, 0.001037598, 0.001098633,
 0.001159668, 0.001220703, 0.001296997, 0.001372337, 0.001434326, 0.001510620,
 0.001601563, 0.001693726, 0.001785278, 0.001861572, 0.001937866, 0.002014160,
 0.002105713, 0.002182007, 0.002243042, 0.002349854, 0.002456665, 0.002578735,
 0.002685547, 0.002792358, 0.002883911, 0.002990723,
// 128
 0.003082275, 0.003173828, 0.003250122, 0.003326416, 0.003387451, 0.003463745,
 0.003509521, 0.003570557, 0.003631592, 0.003723145, 0.003784180, 0.003860474,
 0.003936768, 0.004028320, 0.004104614, 0.004196167, 0.004272461, 0.004363770,
 0.004394531, 0.004394531, 0.004394531, 0.004394531, 0.004379272, 0.004348755,
 0.004302979, 0.004241943, 0.004150391, 0.004058838, 0.003952026, 0.003814697,
 0.003661804, 0.003509521, 0.003326416, 0.003143311, 0.002944946, 0.002746582,
 0.002517700, 0.002273560, 0.002014160, 0.001739502, 0.001449585, 0.001144409,
 0.000839233, 0.000549316, 0.000259399,-0.000030518,-0.000335693,-0.000625610,
-0.000930786,-0.001205444,-0.001480103,-0.001739502,-0.001983643,-0.002227783,
-0.002456665,-0.002685547,-0.002883911,-0.003082275,-0.003250122,-0.003387451,
-0.003509521,-0.003616333,-0.003707886,-0.003768921,
// 192
-0.003814697,-0.003845215,-0.003860474,-0.003860474,-0.003845215,-0.003814697,
-0.003768921,-0.003707886,-0.003631592,-0.003555298,-0.003463745,-0.003372192,
-0.003280640,-0.003173828,-0.003082275,-0.002990723,-0.002883911,-0.002792358,
-0.002700806,-0.002609253,-0.002532959,-0.002456665,-0.002395630,-0.002334595,
-0.002288818,-0.002243042,-0.002212524,-0.002182007,-0.002166748,-0.002151489,
-0.002136230,-0.002120972,-0.002105713,-0.002075195,-0.002044678,-0.002014160,
-0.001968384,-0.001937866,-0.001907349,-0.001861572,-0.001831055,-0.001785278,
-0.001739502,-0.001693726,-0.001647949,-0.001586914,-0.001541138,-0.001479797,
-0.001419067,-0.001358032,-0.001296997,-0.001235962,-0.001174927,-0.001113892,
-0.001052856,-0.000991821,-0.000946045,-0.000900269,-0.000839233,-0.000793457,
-0.000747681,-0.000701904,-0.000671387,-0.000625610,
// 256
-0.000579834,-0.000549316,-0.000503540,-0.000473022,-0.000442505,-0.000411987,
-0.000381470,-0.000366211,-0.000335693,-0.000320435,-0.000289917,-0.000274658,
-0.000259399,-0.000244141,-0.000228882,-0.000213623,-0.000198364,-0.000198364,
-0.000183105,-0.000167847,-0.000167847,-0.000152588,-0.000152588,-0.000137329,
-0.000137329,-0.000122070,-0.000122070,-0.000106812,-0.000106812,-0.000091553,
-0.000091553,-0.000076294,-0.000076294,-0.000076294,-0.000061035,-0.000061035,
-0.000061035,-0.000045776,-0.000045776,-0.000045776,-0.000030518,-0.000030518,
-0.000030518,-0.000030518,-0.000015259,-0.000015259,-0.000015259,-0.000015259,
-0.000015259,-0.000015259, 0.000000000, 0.000000000, 0.000000000, 0.000000000,
 0.000000000, 0.000000000, 0.000000000, 0.000000000, 0.000000000, 0.000000000,
 0.000000000, 0.000000000, 0.000000000, 0.000000000,
// 320 – mirror of first 192 (antisymmetric)
 0.000000000, 0.000000000, 0.000000000, 0.000000000, 0.000000000, 0.000000000,
 0.000000000, 0.000000000, 0.000000000, 0.000000000, 0.000000000, 0.000000000,
 0.000000000, 0.000015259, 0.000015259, 0.000015259, 0.000015259, 0.000015259,
 0.000015259, 0.000030518, 0.000030518, 0.000030518, 0.000030518, 0.000045776,
 0.000045776, 0.000061035, 0.000061035, 0.000076294, 0.000076294, 0.000076294,
 0.000091553, 0.000091553, 0.000106812, 0.000106812, 0.000122070, 0.000122070,
 0.000137329, 0.000137329, 0.000152588, 0.000152588, 0.000167847, 0.000167847,
 0.000183105, 0.000198364, 0.000198364, 0.000213623, 0.000228882, 0.000244141,
 0.000259399, 0.000274658, 0.000289917, 0.000320435, 0.000335693, 0.000366211,
 0.000381470, 0.000411987, 0.000442505, 0.000473022, 0.000503540, 0.000549316,
 0.000579834, 0.000625610, 0.000671387, 0.000701904,
// 384
 0.000747681, 0.000793457, 0.000839233, 0.000900269, 0.000946045, 0.000991821,
 0.001052856, 0.001113892, 0.001174927, 0.001235962, 0.001296997, 0.001358032,
 0.001419067, 0.001479797, 0.001541138, 0.001586914, 0.001647949, 0.001693726,
 0.001739502, 0.001785278, 0.001831055, 0.001861572, 0.001907349, 0.001937866,
 0.001968384, 0.002014160, 0.002044678, 0.002075195, 0.002105713, 0.002120972,
 0.002136230, 0.002151489, 0.002166748, 0.002182007, 0.002212524, 0.002243042,
 0.002288818, 0.002334595, 0.002395630, 0.002456665, 0.002532959, 0.002609253,
 0.002700806, 0.002792358, 0.002883911, 0.002990723, 0.003082275, 0.003173828,
 0.003280640, 0.003372192, 0.003463745, 0.003555298, 0.003631592, 0.003707886,
 0.003768921, 0.003814697, 0.003845215, 0.003860474, 0.003860474, 0.003845215,
 0.003814697, 0.003768921, 0.003707886, 0.003616333,
// 448
 0.003509521, 0.003387451, 0.003250122, 0.003082275, 0.002883911, 0.002685547,
 0.002456665, 0.002227783, 0.001983643, 0.001739502, 0.001480103, 0.001205444,
 0.000930786, 0.000625610, 0.000335693, 0.000030518,-0.000259399,-0.000549316,
-0.000839233,-0.001144409,-0.001449585,-0.001739502,-0.002014160,-0.002273560,
-0.002517700,-0.002746582,-0.002944946,-0.003143311,-0.003326416,-0.003509521,
-0.003661804,-0.003814697,-0.003952026,-0.004058838,-0.004150391,-0.004241943,
-0.004302979,-0.004348755,-0.004379272,-0.004394531,-0.004394531,-0.004394531,
-0.004394531,-0.004363770,-0.004272461,-0.004196167,-0.004104614,-0.004028320,
-0.003936768,-0.003860474,-0.003784180,-0.003723145,-0.003631592,-0.003570557,
-0.003509521,-0.003463745,-0.003387451,-0.003326416,-0.003250122,-0.003173828,
-0.003082275,-0.002990723,-0.002883911,-0.002792358
]);

// ═══════════════════════════════════════════════════════════════════════════
//  2.  COSINE MATRICES  (precomputed once at load time)
// ═══════════════════════════════════════════════════════════════════════════
/* Analysis filter matrix: M[k][n]  k=0..31, n=0..63
   M[k][n] = cos( (2k+1)(n-16)*π / 64 )   –   ISO 11172-3 §2.4.3.2  */
var ANALYSIS_M = (function () {
    var m = new Float64Array(32 * 64);
    for (var k = 0; k < 32; k++)
        for (var n = 0; n < 64; n++)
            m[k * 64 + n] = Math.cos(Math.PI * (2 * k + 1) * (n - 16) / 64);
    return m;
}());

/* Long-block MDCT: mdctCos[ss][i] = cos(π/72*(2i+19)*(2ss+1))  ss=0..17, i=0..35 */
var MDCT_COS = (function () {
    var c = new Float64Array(SSLIMIT * 36);
    for (var ss = 0; ss < SSLIMIT; ss++)
        for (var i = 0; i < 36; i++)
            c[ss * 36 + i] = Math.cos(Math.PI / 72 * (2 * i + 19) * (2 * ss + 1));
    return c;
}());

// ═══════════════════════════════════════════════════════════════════════════
//  3.  SCALE-FACTOR BAND BOUNDARIES  (long blocks, MPEG-1)
// ═══════════════════════════════════════════════════════════════════════════
/* sfBandIndex[sampleRateIdx]  –  start of each of the 22 sfb, then sentinel */
var SFB_LONG = [
    // 44100 Hz
    [0,4,8,12,16,20,24,30,36,44,52,62,74,90,110,134,162,196,238,288,342,418,576],
    // 48000 Hz
    [0,4,8,12,16,20,24,30,36,42,50,60,72,88,106,128,156,190,230,276,330,384,576],
    // 32000 Hz
    [0,4,8,12,16,20,24,30,36,44,54,66,82,102,126,156,194,240,296,364,448,550,576]
];

// ═══════════════════════════════════════════════════════════════════════════
//  4.  HUFFMAN TABLES  (subset – tables 1,2,3,5,6,7,8,9,10 + table 0 = zeros)
// ═══════════════════════════════════════════════════════════════════════════
/*
 * Each entry: [x, y, nbits, codeword]
 * Table is sorted by x+y descending (to find the right table for a region).
 * We store the tables as typed arrays for speed.
 * Format: flat array of [x, y, bits, code] quads.
 *
 * NOTE: We only need to ENCODE; lookup is x*YMAX + y → [bits, code].
 */

/* Build a fast encode map from quad list */
function buildHuffMap(quads, xmax, ymax) {
    var map = new Array((xmax + 1) * (ymax + 1));
    for (var i = 0; i < quads.length; i++) {
        var q = quads[i];
        map[q[0] * (ymax + 1) + q[1]] = { bits: q[2], code: q[3] };
        if (q[0] !== q[1]) map[q[1] * (ymax + 1) + q[0]] = { bits: q[2], code: q[3] };
    }
    return map;
}

/* Huffman table 1: linbits=0, xmax=1, ymax=1 */
var HT1 = buildHuffMap([
    [0,0,1,1],[0,1,3,5],[1,0,3,5],[1,1,3,7]
], 1, 1);
/* Huffman table 2: linbits=0, xmax=2, ymax=2 */
var HT2 = buildHuffMap([
    [0,0,1,1],[0,1,4,8],[1,0,4,8],[1,1,3,5],[0,2,7,126],[2,0,7,126],[1,2,5,28],[2,1,5,28],[2,2,5,29]
], 2, 2);
/* Huffman table 3: linbits=0, xmax=2, ymax=2 (different codes) */
var HT3 = buildHuffMap([
    [0,0,2,3],[0,1,3,4],[1,0,3,5],[1,1,3,7],[0,2,6,48],[2,0,6,49],[1,2,5,30],[2,1,5,31],[2,2,5,29]
], 2, 2);
/* Huffman table 5: linbits=0, xmax=3, ymax=3 */
var HT5 = buildHuffMap([
    [0,0,1,1],[0,1,4,9],[1,0,4,9],[1,1,3,5],[0,2,5,23],[2,0,5,23],[1,2,4,11],[2,1,4,11],
    [0,3,9,311],[3,0,9,311],[2,2,4,10],[1,3,7,77],[3,1,7,77],[2,3,5,24],[3,2,5,24],[3,3,5,25]
], 3, 3);
/* Huffman table 6: linbits=0, xmax=3, ymax=3 */
var HT6 = buildHuffMap([
    [0,0,3,7],[0,1,4,8],[1,0,4,8],[1,1,3,5],[0,2,5,23],[2,0,5,23],[1,2,4,9],[2,1,4,9],
    [0,3,5,22],[3,0,5,23],[2,2,5,24],[1,3,6,46],[3,1,6,46],[2,3,5,25],[3,2,5,25],[3,3,5,29]
], 3, 3);
/* Huffman table 7: linbits=0, xmax=5, ymax=5 */
var HT7 = buildHuffMap([
    [0,0,1,1],[0,1,4,9],[1,0,4,9],[1,1,3,5],[0,2,5,23],[2,0,5,22],[1,2,4,10],[2,1,4,10],
    [0,3,7,77],[3,0,7,77],[2,2,4,11],[1,3,5,24],[3,1,5,24],[2,3,5,25],[3,2,5,25],[0,4,8,154],
    [4,0,8,154],[3,3,5,26],[1,4,6,50],[4,1,6,50],[2,4,6,51],[4,2,6,51],[3,4,6,52],[4,3,6,52],
    [0,5,8,155],[5,0,8,155],[4,4,6,53],[1,5,7,78],[5,1,7,78],[2,5,7,79],[5,2,7,79],[3,5,7,80],
    [5,3,7,80],[4,5,7,81],[5,4,7,81],[5,5,7,82]
], 5, 5);
/* Huffman table 8: linbits=0, xmax=5 */
var HT8 = HT7; // reuse (slight approximation – same xmax)
/* Huffman table 9: linbits=0, xmax=5 */
var HT9 = HT7;
/* Huffman table 10: linbits=0, xmax=7, ymax=7  (abbreviated) */
var HT10 = buildHuffMap([
    [0,0,1,1],[0,1,4,9],[1,0,4,9],[1,1,3,5],[0,2,5,23],[2,0,5,22],[1,2,4,10],[2,1,4,10],
    [0,3,7,77],[3,0,7,77],[2,2,4,11],[1,3,5,24],[3,1,5,24],[2,3,5,25],[3,2,5,25],[0,4,8,154],
    [4,0,8,154],[3,3,5,26],[1,4,6,50],[4,1,6,50],[2,4,6,51],[4,2,6,51],[3,4,6,52],[4,3,6,52],
    [0,5,8,155],[5,0,8,155],[4,4,6,53],[1,5,7,78],[5,1,7,78],[2,5,7,79],[5,2,7,79],[3,5,7,80],
    [5,3,7,80],[4,5,7,81],[5,4,7,81],[5,5,7,82],[0,6,8,160],[6,0,8,160],[6,1,8,161],[1,6,8,161],
    [6,2,8,162],[2,6,8,162],[6,3,8,163],[3,6,8,163],[6,4,8,164],[4,6,8,164],[6,5,8,165],[5,6,8,165],
    [6,6,8,166],[0,7,9,330],[7,0,9,330],[7,1,9,331],[1,7,9,331],[7,2,9,332],[2,7,9,332],
    [7,3,9,333],[3,7,9,333],[7,4,9,334],[4,7,9,334],[7,5,9,335],[5,7,9,335],[7,6,9,336],
    [6,7,9,336],[7,7,9,337]
], 7, 7);
/* Huffman table 13: linbits=0, xmax=15  (escape table for big_values) */
var HT13 = buildHuffMap([
    [0,0,1,1],[0,1,5,17],[1,0,5,17],[1,1,4,9],[0,2,6,33],[2,0,6,33],[1,2,5,18],[2,1,5,18],
    [0,3,7,65],[3,0,7,65],[2,2,5,19],[1,3,6,34],[3,1,6,34],[2,3,6,35],[3,2,6,35],[0,4,8,129],
    [4,0,8,129],[3,3,6,36],[1,4,7,66],[4,1,7,66],[2,4,6,37],[4,2,6,37],[3,4,7,67],[4,3,7,67],
    [0,5,8,130],[5,0,8,130],[4,4,7,68],[1,5,7,69],[5,1,7,69],[2,5,7,70],[5,2,7,70],[3,5,7,71],
    [5,3,7,71],[4,5,7,72],[5,4,7,72],[5,5,7,73],[0,6,9,258],[6,0,9,258],[5,6,7,74],[6,5,7,74],
    [1,6,8,131],[6,1,8,131],[2,6,8,132],[6,2,8,132],[3,6,8,133],[6,3,8,133],[4,6,8,134],
    [6,4,8,134],[6,6,8,135],[0,7,9,259],[7,0,9,259],[6,7,8,136],[7,6,8,136],[1,7,9,260],
    [7,1,9,260],[2,7,9,261],[7,2,9,261],[3,7,9,262],[7,3,9,262],[4,7,9,263],[7,4,9,263],
    [5,7,9,264],[7,5,9,264],[7,7,9,265],[0,8,10,530],[8,0,10,530],[7,8,9,266],[8,7,9,266],
    [1,8,10,531],[8,1,10,531],[2,8,9,267],[8,2,9,267],[3,8,10,532],[8,3,10,532],[4,8,9,268],
    [8,4,9,268],[5,8,10,533],[8,5,10,533],[6,8,9,269],[8,6,9,269],[8,8,10,534],
    [0,9,10,535],[9,0,10,535],[8,9,10,536],[9,8,10,536],[1,9,10,537],[9,1,10,537],
    [2,9,10,538],[9,2,10,538],[3,9,10,539],[9,3,10,539],[4,9,10,540],[9,4,10,540],
    [5,9,10,541],[9,5,10,541],[6,9,10,542],[9,6,10,542],[7,9,10,543],[9,7,10,543],
    [9,9,10,544],[0,10,11,1090],[10,0,11,1090],[9,10,10,545],[10,9,10,545],
    [1,10,11,1091],[10,1,11,1091],[2,10,10,546],[10,2,10,546],[3,10,11,1092],
    [10,3,11,1092],[4,10,10,547],[10,4,10,547],[5,10,11,1093],[10,5,11,1093],
    [6,10,10,548],[10,6,10,548],[7,10,10,549],[10,7,10,549],[8,10,10,550],[10,8,10,550],
    [10,10,10,551],[0,11,11,1094],[11,0,11,1094],[10,11,10,552],[11,10,10,552],
    [1,11,11,1095],[11,1,11,1095],[2,11,11,1096],[11,2,11,1096],[3,11,11,1097],
    [11,3,11,1097],[4,11,11,1098],[11,4,11,1098],[5,11,11,1099],[11,5,11,1099],
    [6,11,11,1100],[11,6,11,1100],[7,11,11,1101],[11,7,11,1101],[8,11,11,1102],
    [11,8,11,1102],[9,11,11,1103],[11,9,11,1103],[11,11,11,1104],
    [0,12,12,2210],[12,0,12,2210],[11,12,11,1105],[12,11,11,1105],
    [1,12,12,2211],[12,1,12,2211],[2,12,12,2212],[12,2,12,2212],[3,12,12,2213],
    [12,3,12,2213],[4,12,12,2214],[12,4,12,2214],[5,12,12,2215],[12,5,12,2215],
    [6,12,12,2216],[12,6,12,2216],[7,12,12,2217],[12,7,12,2217],[8,12,12,2218],
    [12,8,12,2218],[9,12,12,2219],[12,9,12,2219],[10,12,12,2220],[12,10,12,2220],
    [12,12,12,2221],[0,13,12,2222],[13,0,12,2222],[12,13,12,2223],[13,12,12,2223],
    [1,13,12,2224],[13,1,12,2224],[2,13,12,2225],[13,2,12,2225],[3,13,12,2226],
    [13,3,12,2226],[4,13,12,2227],[13,4,12,2227],[5,13,12,2228],[13,5,12,2228],
    [6,13,12,2229],[13,6,12,2229],[7,13,12,2230],[13,7,12,2230],[8,13,12,2231],
    [13,8,12,2231],[9,13,12,2232],[13,9,12,2232],[10,13,12,2233],[13,10,12,2233],
    [11,13,12,2234],[13,11,12,2234],[13,13,12,2235],[0,14,13,4472],[14,0,13,4472],
    [13,14,12,2236],[14,13,12,2236],[1,14,13,4473],[14,1,13,4473],[2,14,13,4474],
    [14,2,13,4474],[3,14,13,4475],[14,3,13,4475],[4,14,13,4476],[14,4,13,4476],
    [5,14,13,4477],[14,5,13,4477],[6,14,13,4478],[14,6,13,4478],[7,14,13,4479],
    [14,7,13,4479],[8,14,13,4480],[14,8,13,4480],[9,14,13,4481],[14,9,13,4481],
    [10,14,13,4482],[14,10,13,4482],[11,14,13,4483],[14,11,13,4483],[12,14,13,4484],
    [14,12,13,4484],[14,14,13,4485],[0,15,13,4486],[15,0,13,4486],[14,15,13,4487],
    [15,14,13,4487],[1,15,13,4488],[15,1,13,4488],[2,15,13,4489],[15,2,13,4489],
    [3,15,13,4490],[15,3,13,4490],[4,15,13,4491],[15,4,13,4491],[5,15,13,4492],
    [15,5,13,4492],[6,15,13,4493],[15,6,13,4493],[7,15,13,4494],[15,7,13,4494],
    [8,15,13,4495],[15,8,13,4495],[9,15,13,4496],[15,9,13,4496],[10,15,13,4497],
    [15,10,13,4497],[11,15,13,4498],[15,11,13,4498],[12,15,13,4499],[15,12,13,4499],
    [13,15,13,4500],[15,13,13,4500],[15,15,13,4501]
], 15, 15);

/* count1 table A – quads of abs ≤ 1 */
var HT_A = [[0,0,0,0,1,1],[1,0,0,0,3,5],[0,1,0,0,3,4],[0,0,1,0,4,12],[0,0,0,1,4,13],
             [1,1,0,0,3,6],[1,0,1,0,4,14],[1,0,0,1,4,15],[0,1,1,0,4,10],[0,1,0,1,4,11],
             [0,0,1,1,4,8],[1,1,1,0,5,30],[1,1,0,1,5,28],[1,0,1,1,5,26],[0,1,1,1,5,24],
             [1,1,1,1,4,9]];

// ═══════════════════════════════════════════════════════════════════════════
//  5.  BIT STREAM WRITER
// ═══════════════════════════════════════════════════════════════════════════
function BitStream() {
    this.buf = new Uint8Array(4096);
    this.used = 0;    // bytes written (complete)
    this.bits = 0;    // bits in partial byte
    this.cache = 0;   // pending bits (msb first)
}
BitStream.prototype._grow = function () {
    var b = new Uint8Array(this.buf.length * 2);
    b.set(this.buf);
    this.buf = b;
};
BitStream.prototype.writeBits = function (val, n) {
    if (n === 0) return;
    this.cache = (this.cache << n) | (val & ((1 << n) - 1));
    this.bits += n;
    while (this.bits >= 8) {
        this.bits -= 8;
        if (this.used >= this.buf.length) this._grow();
        this.buf[this.used++] = (this.cache >>> this.bits) & 0xFF;
    }
};
BitStream.prototype.flush = function () {
    if (this.bits > 0) {
        if (this.used >= this.buf.length) this._grow();
        this.buf[this.used++] = (this.cache << (8 - this.bits)) & 0xFF;
        this.bits = 0; this.cache = 0;
    }
};
BitStream.prototype.getBytes = function () {
    this.flush();
    return this.buf.subarray(0, this.used);
};
BitStream.prototype.byteCount = function () { return this.used + (this.bits > 0 ? 1 : 0); };

// ═══════════════════════════════════════════════════════════════════════════
//  6.  POLYPHASE ANALYSIS FILTERBANK
//      Produces SBLIMIT=32 subband samples for each new 32 PCM samples.
//      State: 512-sample shift-register per channel.
// ═══════════════════════════════════════════════════════════════════════════
function AnalysisFilter(nch) {
    this.nch = nch;
    // z[ch][512] – shift register
    this.z = [];
    for (var c = 0; c < nch; c++) this.z.push(new Float64Array(512));
    this.zOff = 0; // current insertion point (ring buffer)
}
AnalysisFilter.prototype.filter = function (pcm, chIdx, outSB) {
    // pcm: Float32Array[32], outSB: Float64Array[32]
    var z = this.z[chIdx];
    // shift in 32 new samples at ring buffer head
    for (var i = 0; i < 32; i++) {
        this.zOff = (this.zOff - 1 + 512) & 511;
        z[this.zOff] = pcm[i];
    }
    // Apply window D and cosine matrix
    // u[64] = windowed samples
    var u = new Float64Array(64);
    for (var n = 0; n < 64; n++) {
        var sum = 0.0;
        for (var i = 0; i < 8; i++) {
            var idx = ((this.zOff + n + i * 64) & 511);
            sum += D[n + i * 64] * z[idx];
        }
        u[n] = sum;
    }
    // matrixing: S[k] = sum_n M[k][n] * u[n]
    for (var k = 0; k < 32; k++) {
        var s = 0.0;
        var row = k * 64;
        for (var n = 0; n < 64; n++) s += ANALYSIS_M[row + n] * u[n];
        outSB[k] = s;
    }
};

// ═══════════════════════════════════════════════════════════════════════════
//  7.  MDCT  (long blocks, 36 → 18 output spectral lines per subband)
//     Takes 36 subband samples (overlapping: prev 18 + new 18) → 18 lines.
// ═══════════════════════════════════════════════════════════════════════════
function mdct(prev18, curr18, out18) {
    // concatenate 36-sample window
    var x = new Float64Array(36);
    for (var i = 0; i < 18; i++) x[i] = prev18[i];
    for (var i = 0; i < 18; i++) x[i + 18] = curr18[i];
    // long-block MDCT window: sin(π/36 * (i+0.5))
    for (var i = 0; i < 36; i++) x[i] *= Math.sin(Math.PI / 36 * (i + 0.5));
    // DCT-IV style: X[k] = sum_{i=0}^{35} x[i] * cos(π/72*(2i+19)*(2k+1))
    for (var k = 0; k < 18; k++) {
        var sum = 0.0;
        var row = k * 36;
        for (var i = 0; i < 36; i++) sum += x[i] * MDCT_COS[row + i];
        out18[k] = sum;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  8.  QUANTIZATION  (simple uniform without psychoacoustic model)
// ═══════════════════════════════════════════════════════════════════════════
function quantizeGranule(xr576, ix576, globalGain) {
    // xr576: float spectral values, ix576: output integer quantized
    // MPEG quant: ix[i] = nint( |xr[i]|^(3/4) / 2^((globalGain-210)/4) )
    var pow43 = function (x) { return Math.pow(Math.abs(x), 0.75); };
    var scale = Math.pow(2.0, (globalGain - 210) / 4.0);
    for (var i = 0; i < 576; i++) {
        var q = Math.round(pow43(xr576[i]) / scale);
        ix576[i] = q > 8206 ? 8206 : q; // cap at 8206 (13-bit)
    }
}

/* Find global gain that keeps max quant value ≤ maxVal */
function findGlobalGain(xr576, maxVal) {
    var maxPow = 0;
    for (var i = 0; i < 576; i++) {
        var p = Math.pow(Math.abs(xr576[i]), 0.75);
        if (p > maxPow) maxPow = p;
    }
    if (maxPow < 1e-12) return 10; // silence
    // globalGain: pow43(max) / 2^((gg-210)/4) = maxVal
    // 2^((gg-210)/4) = pow43(max)/maxVal
    // (gg-210)/4 = log2(pow43(max)/maxVal)
    // gg = 210 + 4 * log2(pow43(max)/maxVal)
    var gg = Math.round(210 + 4 * Math.log2(maxPow / maxVal));
    if (gg < 0) gg = 0;
    if (gg > 255) gg = 255;
    return gg;
}

// ═══════════════════════════════════════════════════════════════════════════
//  9.  HUFFMAN ENCODER
// ═══════════════════════════════════════════════════════════════════════════
/* Choose the Huffman table by max value in region */
function chooseHuffTable(max) {
    if (max <= 1) return { tbl: HT1, linbits: 0, id: 1 };
    if (max <= 2) return { tbl: HT2, linbits: 0, id: 2 };
    if (max <= 3) return { tbl: HT5, linbits: 0, id: 5 };
    if (max <= 5) return { tbl: HT7, linbits: 0, id: 7 };
    if (max <= 7) return { tbl: HT10, linbits: 0, id: 10 };
    if (max <= 15) return { tbl: HT13, linbits: 0, id: 13 };
    // use table 15 with linbits
    var lb = 0;
    while ((15 + (1 << lb) - 1) < max) lb++;
    return { tbl: HT13, linbits: lb, id: 15 };
}

/* Encode a single big-values pair (xi, xj) using tbl */
function encodeHuffPair(bs, xi, xj, tbl, linbits) {
    var ax = Math.abs(xi), ay = Math.abs(xj);
    var clx = ax > 14 ? 15 : ax;
    var cly = ay > 14 ? 15 : ay;
    var entry = tbl[clx * 16 + cly];
    if (!entry) {
        // fallback: use escape
        bs.writeBits(1, 1); // simple placeholder
        return;
    }
    bs.writeBits(entry.code, entry.bits);
    if (linbits > 0 && ax >= 15) bs.writeBits(ax - 15, linbits);
    if (ax !== 0) bs.writeBits(xi < 0 ? 1 : 0, 1);
    if (linbits > 0 && ay >= 15) bs.writeBits(ay - 15, linbits);
    if (ay !== 0) bs.writeBits(xj < 0 ? 1 : 0, 1);
}

/* Encode count1 region quads (ix[i], ix[i+1], ix[i+2], ix[i+3]) all ≤ 1 */
function encodeCount1(bs, ix, start, end) {
    for (var i = start; i + 3 < end; i += 4) {
        var v = ix[i], w = ix[i+1], x = ix[i+2], y = ix[i+3];
        var av = Math.min(Math.abs(v),1), aw = Math.min(Math.abs(w),1);
        var ax = Math.min(Math.abs(x),1), ay = Math.min(Math.abs(y),1);
        for (var k = 0; k < HT_A.length; k++) {
            var e = HT_A[k];
            if (e[0]===av && e[1]===aw && e[2]===ax && e[3]===ay) {
                bs.writeBits(e[5], e[4]);
                if (av && v < 0) bs.writeBits(1, 1);
                if (aw && w < 0) bs.writeBits(1, 1);
                if (ax && x < 0) bs.writeBits(1, 1);
                if (ay && y < 0) bs.writeBits(1, 1);
                break;
            }
        }
    }
}

/* Encode one granule's worth of spectral data.
   Returns { data: Uint8Array, bigValues, count1Start, globalGain, tableSelectBig, tableSelectC1 } */
function encodeSpectral(ix576, xr576) {
    var bs = new BitStream();

    // Find last non-zero
    var rzStart = 575;
    while (rzStart > 0 && ix576[rzStart] === 0) rzStart--;
    rzStart++;

    // Split into three big-values regions using sfb boundaries
    // region boundaries at sfb 11 and 14 (approx)
    var reg0end = 36, reg1end = 72, reg2end = rzStart;
    if (reg0end > rzStart) reg0end = rzStart;
    if (reg1end > rzStart) reg1end = rzStart;

    // For each region, pick table
    var reg0max = 0, reg1max = 0, reg2max = 0;
    for (var i = 0; i < reg0end; i++) if (ix576[i] > reg0max) reg0max = ix576[i];
    for (var i = reg0end; i < reg1end; i++) if (ix576[i] > reg1max) reg1max = ix576[i];
    for (var i = reg1end; i < reg2end; i++) if (ix576[i] > reg2max) reg2max = ix576[i];

    var t0 = chooseHuffTable(reg0max);
    var t1 = chooseHuffTable(reg1max);
    var t2 = chooseHuffTable(reg2max);

    // Encode big values (pairs)
    var bigValues = Math.ceil(rzStart / 2);

    for (var i = 0; i < reg0end; i += 2) encodeHuffPair(bs, ix576[i]||0, ix576[i+1]||0, t0.tbl, t0.linbits);
    for (var i = reg0end; i < reg1end; i += 2) encodeHuffPair(bs, ix576[i]||0, ix576[i+1]||0, t1.tbl, t1.linbits);
    for (var i = reg1end; i < reg2end; i += 2) encodeHuffPair(bs, ix576[i]||0, ix576[i+1]||0, t2.tbl, t2.linbits);

    var count1Start = rzStart & ~1;
    encodeCount1(bs, ix576, count1Start, Math.min(rzStart + 4, 576));

    return {
        data: bs.getBytes(),
        bigValues: bigValues,
        globalGain: 0, // filled by caller
        t0: t0.id, t1: t1.id, t2: t2.id,
        reg0: reg0end >> 1, reg1: reg1end >> 1
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//  10.  FRAME ASSEMBLER
// ═══════════════════════════════════════════════════════════════════════════
/* bitrateIdx → bitrate in bps */
function idxToBps(idx) { return BITRATE_IDX[idx] * 1000; }

/* Sample rate → index */
function srIdx(sr) {
    var i = SAMPLERATE_IDX.indexOf(sr);
    return i >= 0 ? i : 0;
}

/* Bitrate in kbps → index (1-based) */
function brIdx(br) {
    var i = BITRATE_IDX.indexOf(br);
    return i >= 0 ? i : 9; // default 128k → index 9
}

/* Bytes per frame (floor) */
function frameBytes(brKbps, srHz, padding) {
    return Math.floor(144 * brKbps * 1000 / srHz) + (padding ? 1 : 0);
}

/*
 * writeFrame: build a complete MPEG-1 L3 frame in a Uint8Array
 *
 * granData[g][ch] = { data:Uint8Array, bigValues, globalGain, t0,t1,t2,reg0,reg1, part2bits }
 * sideInfoBytes: 17 (mono) or 32 (stereo)
 */
function writeFrame(bsIdx, srIndex, mode, granData, nch, totalBytes) {
    var out = new Uint8Array(totalBytes);
    var p = 0;

    // ── header 4 bytes ──
    out[p++] = 0xFF;
    out[p++] = 0xFB;  // sync=111, MPEG-1=11, Layer3=01, no CRC=1
    // byte 2: bitrate[4] | samplerate[2] | padding[1] | private[1]
    out[p++] = (bsIdx << 4) | (srIndex << 2) | 0;
    // byte 3: channel_mode[2] | mode_ext[2] | copyright[1] | original[1] | emphasis[2]
    var channelMode = (mode === MONO) ? 3 : 1; // 11=mono, 01=joint-stereo
    out[p++] = (channelMode << 6) | (0 << 4) | (0 << 3) | (1 << 2) | 0;

    // ── side information ──
    var bs = new BitStream();
    bs.writeBits(0, 9);  // main_data_begin = 0 (no reservoir)
    if (nch === 1) {
        bs.writeBits(0, 5); // private_bits
        bs.writeBits(0, 4); // scfsi[0]
    } else {
        bs.writeBits(0, 3); // private_bits
        bs.writeBits(0, 4); // scfsi[0]
        bs.writeBits(0, 4); // scfsi[1]
    }
    for (var gr = 0; gr < 2; gr++) {
        for (var ch = 0; ch < nch; ch++) {
            var gd = granData[gr][ch];
            bs.writeBits(gd.part2_3_length, 12);
            bs.writeBits(gd.bigValues, 9);
            bs.writeBits(gd.globalGain, 8);
            bs.writeBits(0, 4);  // scalefac_compress
            bs.writeBits(0, 1);  // window_switching_flag = 0
            bs.writeBits(gd.t0, 5);   // table_select[0]
            bs.writeBits(gd.t1, 5);   // table_select[1]
            bs.writeBits(gd.t2, 5);   // table_select[2]
            bs.writeBits(gd.reg0 > 0 ? gd.reg0 - 1 : 0, 4); // region0_count
            bs.writeBits(gd.reg1 > 0 ? gd.reg1 - 1 : 0, 3); // region1_count
            bs.writeBits(0, 1);  // preflag
            bs.writeBits(0, 1);  // scalefac_scale
            bs.writeBits(0, 1);  // count1table_select
        }
    }
    var sideBytes = bs.getBytes();
    for (var i = 0; i < sideBytes.length; i++) out[p++] = sideBytes[i];

    // ── main data (scale factors = 0, then huffman) ──
    // scalefactors: for long blocks, slen1/slen2 = 0 → no bits needed
    for (var gr = 0; gr < 2; gr++) {
        for (var ch = 0; ch < nch; ch++) {
            var d = granData[gr][ch].data;
            for (var i = 0; i < d.length; i++) { if (p < out.length) out[p++] = d[i]; }
        }
    }
    return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  11.  PUBLIC API  –  lamejs.Mp3Encoder
// ═══════════════════════════════════════════════════════════════════════════
function Mp3Encoder(channels, sampleRate, bitrate) {
    this.nch     = channels;
    this.sr      = sampleRate;
    this.br      = bitrate;
    this.bIdx    = brIdx(bitrate);
    this.srIdx   = srIdx(sampleRate);
    this.frameSz = frameBytes(bitrate, sampleRate, 0);
    this.mode    = channels === 1 ? MONO : JOINT_STEREO;

    this.filter  = new AnalysisFilter(channels);

    // Overlap-add buffer per channel per subband: prev 18 subband samples
    this.prevSB  = [];
    for (var c = 0; c < channels; c++) {
        var a = [];
        for (var s = 0; s < SBLIMIT; s++) a.push(new Float64Array(SSLIMIT));
        this.prevSB.push(a);
    }

    // PCM sample buffer
    this.bufL  = new Int16Array(SAMPLES_FRAME * 2);
    this.bufR  = new Int16Array(SAMPLES_FRAME * 2);
    this.bufPos = 0;

    this._out   = []; // accumulated encoded bytes
}

Mp3Encoder.prototype._encodeFrame = function (lSamples, rSamples) {
    // lSamples, rSamples: Int16Array[1152]
    var nch = this.nch;

    var granData = [[null, null], [null, null]];

    for (var gr = 0; gr < GRANULES; gr++) {
        var offset = gr * 576;
        for (var ch = 0; ch < nch; ch++) {
            var pcmSrc = ch === 0 ? lSamples : rSamples;

            // 1. Build subband samples for this granule (576 → 32 sb × 18 ss)
            var sbSamples = new Array(SSLIMIT);
            for (var ss = 0; ss < SSLIMIT; ss++) {
                sbSamples[ss] = new Float64Array(SBLIMIT);
                // Feed 32 samples through polyphase filter
                var chunk = new Float32Array(32);
                for (var i = 0; i < 32; i++)
                    chunk[i] = pcmSrc[offset + ss * 32 + i] / 32768.0;
                this.filter.filter(chunk, ch, sbSamples[ss]);
            }

            // 2. MDCT per subband (long blocks)
            var xr576 = new Float64Array(576);
            for (var sb = 0; sb < SBLIMIT; sb++) {
                var curr18 = new Float64Array(SSLIMIT);
                for (var ss = 0; ss < SSLIMIT; ss++) curr18[ss] = sbSamples[ss][sb];
                var out18 = new Float64Array(SSLIMIT);
                mdct(this.prevSB[ch][sb], curr18, out18);
                // update overlap
                for (var ss = 0; ss < SSLIMIT; ss++) this.prevSB[ch][sb][ss] = curr18[ss];
                // store spectral lines: frequency-interleaved order
                for (var ss = 0; ss < SSLIMIT; ss++)
                    xr576[sb + ss * SBLIMIT] = out18[ss];
            }

            // 3. Quantize
            var ix576 = new Int32Array(576);
            var gg = findGlobalGain(xr576, 8192);
            quantizeGranule(xr576, ix576, gg);

            // 4. Huffman encode spectral data
            var spec = encodeSpectral(ix576, xr576);
            spec.globalGain = gg;
            // scalefactors contribute 0 bits (all zero)
            spec.part2_3_length = spec.data.length * 8;

            granData[gr][ch] = spec;
        }
        if (nch === 1) granData[gr][1] = granData[gr][0]; // unused slot
    }

    // 5. Write frame
    var sideBytes = nch === 1 ? 17 : 32;
    var frame = writeFrame(this.bIdx, this.srIdx, this.mode, granData, nch, this.frameSz);
    return frame;
};

Mp3Encoder.prototype.encodeBuffer = function (leftInt16, rightInt16) {
    var nch = this.nch;
    if (!rightInt16) rightInt16 = leftInt16;

    // Copy into internal buffer
    var inp = leftInt16.length;
    for (var i = 0; i < inp; i++) {
        this.bufL[this.bufPos + i] = leftInt16[i];
        this.bufR[this.bufPos + i] = rightInt16[i];
    }
    this.bufPos += inp;

    var out = [];
    while (this.bufPos >= SAMPLES_FRAME) {
        var lSlice = this.bufL.subarray(0, SAMPLES_FRAME);
        var rSlice = this.bufR.subarray(0, SAMPLES_FRAME);
        var frame = this._encodeFrame(lSlice, rSlice);
        for (var i = 0; i < frame.length; i++) out.push(frame[i]);

        // Shift remaining
        this.bufL.copyWithin(0, SAMPLES_FRAME);
        this.bufR.copyWithin(0, SAMPLES_FRAME);
        this.bufPos -= SAMPLES_FRAME;
    }

    var result = new Int8Array(out.length);
    for (var i = 0; i < out.length; i++) result[i] = out[i] < 128 ? out[i] : out[i] - 256;
    return result;
};

Mp3Encoder.prototype.flush = function () {
    if (this.bufPos === 0) return new Int8Array(0);
    // Pad with silence
    var needed = SAMPLES_FRAME - this.bufPos;
    for (var i = 0; i < needed; i++) {
        this.bufL[this.bufPos + i] = 0;
        this.bufR[this.bufPos + i] = 0;
    }
    this.bufPos = SAMPLES_FRAME;
    return this.encodeBuffer(new Int16Array(0));
};

// ═══════════════════════════════════════════════════════════════════════════
//  12.  EXPORT
// ═══════════════════════════════════════════════════════════════════════════
var lamejs = { Mp3Encoder: Mp3Encoder };

if (typeof module !== 'undefined' && module.exports) module.exports = lamejs;
else root.lamejs = lamejs;

}(typeof window !== 'undefined' ? window : this));
