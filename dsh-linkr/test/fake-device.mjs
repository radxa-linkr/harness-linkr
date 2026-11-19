/**
 * A fake Linkr device for tests and for the Host plugin's integration harness.
 *
 * It implements exactly the slice of the device protocol the transport uses
 * (CONTRACT.md §1) with Node built-ins only:
 *
 *   POST /api/account/login      salted-SHA256 login, answers a token
 *   GET  /linkr/info             unauthenticated identity (rate-limit headers included)
 *   GET  /api/device/info        model / sn
 *   GET  /api/device/version     firmware version
 *   GET  /api/video/codec        { video_codec }
 *   POST /api/video/codec        records every write, changes the mode
 *   POST /api/rtc/whep           ws_mjpeg while the mode is 1, ws_h264 while it is 2
 *   POST /api/paste              records pasted text
 *   GET  /ws/media?authorization=...   RFC 6455 upgrade + subprotocol ws-media:
 *                                      mode 1 pushes canned JPEG frames, mode 2
 *                                      pushes 25-byte ws-media H.264 packets
 *                                      (needs a clip) and records every binary
 *                                      frame the client sends (HID)
 *
 * Everything mutable is exposed so a test can assert on it:
 *
 *   const fake = createFakeDevice();
 *   const origin = await fake.listen();
 *   ... drive the client ...
 *   fake.codecWrites        // [{ video_codec, at }]
 *   fake.hidFrames          // [Buffer, ...]  raw frames received on the socket
 *   fake.pastes             // ['...']
 *   fake.logins             // number of successful logins
 *   fake.requests           // [{ method, path, status }]
 *   await fake.close();
 *
 * No credentials of the real device are involved.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

/* ----------------------------------------------------- canned MJPEG frame */

/** Base64 of a real 640x360 JPEG (generated once with Pillow, quality 55). */
const CANNED_JPEG_BASE64 = [
  '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',
  'eXxtLyFe1a87dTjXWcvf2qus+OHnjzT+PkTJhSZMOTugAFqA0EyYQuTCAR1+/T3L7/4uQdfv09y+/wDi60fSr089zyUe3KpkwpMm',
  'HJ3QPv3C4+3O/wDyYu1R9uk1VP6u7W367VzW6WOtbZJbNt1t91fJpspW+v8Avb7aewF5A6q6COzS/wCLtpqLp5pdHbWnq2XWRXer',
  '/wB1La+r9/32Pj3at1H9LDdWTW1h/p4P7ax18zT9O32Xbdnt/b2tBz8mEOlppdRTfFuRqKwS+YrXR/qeRXyf+EdPb7G+5GzU3bga',
  'WuzzkXkzxV/3snv8unNpSv2/uE5Nq9y62noHS3aetf6ymlu8qmz2Q+dk8qtv7/7/AG2/u33xS+c/r6Unln8jX3Ur52mzzP8Az2W2',
  '+uvqr6/9f8aepQnOJkw7Sn9Twjn/AK7zvmv6+z+m87t/5eep/wANuPJ8r2er2fs8q6LVTz3aGa/WyXamKtIv6uytlfLtrS6mzbWv',
  't2bPuSc6Oq8757S1rpK7ZbL549JWntr5NsFtNn7+RS7/AM/ux0NNddLq6T36izV/0NNt0Ftbp6frWf8AKm2lduz9/ZsBeAN9ZSSm',
  'rkpNWa6/b66zU2X1/wDmm2rBoJkwhcmEAjVk1UATJhSZMJIABagNBMmELkwgEasmqgCZMKTJhJAALUBoJkwhcmEAjVk1UATJhSZM',
  'JIABagNBMmELkwgEasmqgCZMKTJhJAALUBoJkwhcmEAjVk1UATJhSZMJIABagNBMmELkwgF0O8vjaXkK9q1526nGus5e/tVejvL4',
  '2l5CvatedupxrrOXv7VXWfHDzx5p/HyJkwpMmHJ3QAC1AaCZMIXJhAI6/fp7l9/8XIOv36e5ff8AxdaPpV6ee55KPblUyYUmTDk7',
  'oABagNBMmELkwgEasmqgCZMKTJhJAALUBoJkwhcmEAjVk1UATJhSZMJIABagNBMmELkwgEasmqgCZMKTJhJAALUBoJkwhcmEAjVk',
  '1UATJhSZMJIABagNBMmELkwgEasmqgCZMKTJhJAALUBoJkwhcmEAjVk1UATJhSZMJIABagNBMmELkwgF0O8vjaXkK9q1526nGus5',
  'e/tVejvL42l5CvatedupxrrOXv7VXWfHDzx5p/HyJkwpMmHJ3QAC1AaCZMIXJhAI6/fp7l9/8XIOv36e5ff/ABdaPpV6ee55KPbl',
  'UyYUmTDk7vyOO6WS2yO3yrrq7KUXfpprJrIq2bb79nk0trS6l232bK09VWm581sGrtvv2eT5N9u2tNtKeVbWm2tP/L6b9Xp45qXU',
  's87d5nyK3xV83Sl1a121tpW31equz2UzVL5lnfodRHSSt8ezzda23U8qm31V2V2U2+ulP90fM9rWa3Sy6mXURyV2UtmjtsrSu2/y',
  '63bLvZs2f359fqfJZqI6bl3Q1k/WrtrSuyvqt20/s/8APt/8fvUsxMvlv0c9YaS0s227Nuyl1PK2VrspXZ7dm3L8roNTbfSytlu2',
  'tK12+Xb5NNnt2127KbP3ffpdVp9HZbd5zy6VujvrHSz++l1t1K1212eu31V9W3/SbtRp6w3w1mi8qSy62slkdbbKf3WXW7abNu3+',
  '2tK12Zp7UfmXlyx3wyXRyW+TdbXZWi3201UX9ZNdZL5uvmbYo5tlfVW2ltPK9XrptpbX/wC31zauC7c+eOup87Jfb7K2Vt23+XT1',
  '0ps2f8aV9dfWoXy8dMmHu13Sik3QvklmrdHbrrJY9tK/2x0rdtrSmP8Ap9TGHdCysVldRJSuop5ylt9/lf2Ur5Faeu310p6r6er2',
  'bUPmXkRRXzTWRR08q+S6lttNuzbWvqoqPTyyaeWeyzbFD5Pl3baerb7Hs6fdGC3Wxy01NIKWz23y1tsu2S20pbT9619dLq+v/u2+',
  '18W52ohj0s8E0nkWzX20r6q12W+TfTb6v9VrbUfB+ZYTaeWCkfnbfJ87ZSSz109dtfZX/wDTb0fqdt1PItpdbfdH5Nb7dtbrdm2l',
  'KbfX7aex9Grm02tkj2y+apbFW22taV2W185dWlK7Kf8AbXH7K1G6Me26WGy26WuqlmsrfSu2ylfJ8mtPXs2+qvt2+xofMvgl0M9P',
  'N08myt19La220ktrdXyqUrT1bdvsqxn00sFLayUt8m/b5N1t1LqV2e310rserJqdL52GTy4f/RtiuupSTzlP0/Ir/wC31V//AI+L',
  'VXQWaXT2QS23TWX31vrZ5dKf9Oyv92fb7NnsZkxMvm1EF+mnvhk2eXZXZdSlduyuaP17Eu6UUuqrX+pvpZdqppfK2V9laW+br7PZ',
  'tp/80/8AprZujBHq7rrZv7L5tPWStKXbLrbbK0v27fXWm2ufafgfMvCTJh7kO6EdYo63y201Pm7aXSX+X6tl9+2m231+ytv7ep4+',
  'svtk1Ml9tKUtuvurSlKbKUpt/wBYUmJYAMtNQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyY',
  'QCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQC6HeXxtLyFe1a87dTjXWcvf2qvR3l8bS8hXtWvO3U411',
  'nL39qrrPjh5480/j5EyYUmTDk7oABagNBMmELkwgEdfv09y+/wDi5B1+/T3L7/4utH0q9PPc8lHtyqZMKTJhyd0AAtQGgmTCFyYQ',
  'CNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAt',
  'QGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQC6HeXxtLyFe1a87dTjXWcvf2qvR3l8bS8hX',
  'tWvO3U411nL39qrrPjh5480/j5EyYUmTDk7oABagNBMmELkwgEdfv09y+/8Ai5B1+/T3L7/4utH0q9PPc8lHtyqZMKTJhyd0AAtQ',
  'GgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJk',
  'wpMmEkAAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQC6HeXxtLyFe1a87dTjXWcvf2qv',
  'R3l8bS8hXtWvO3U411nL39qrrPjh5480/j5EyYUmTDk7oABagNBMmELkwgEdfv09y+/+LkHX79Pcvv8A4utH0q9PPc8lHtyqZMKT',
  'Jhyd0AAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTC',
  'ARqyaqAJkwpMmEkAAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQC6HeXxtLyFe1a87dT',
  'jXWcvf2qvR3l8bS8hXtWvO3U411nL39qrrPjh5480/j5EyYUmTDk7oABagNBMmELkwgEdfv09y+/+LkHX79Pcvv/AIutH0q9PPc8',
  'lHtyqZMKTJhyd0AAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQCNWTVQBMmFJkwkgAFq',
  'A0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQC6HeXxtL',
  'yFe1a87dTjXWcvf2qvR3l8bS8hXtWvO3U411nL39qrrPjh5480/j5EyYUmTDk7oABagNBMmELkwgEdfv09y+/wDi5B1+/T3L7/4u',
  'tH0q9PPc8lHtyqZMKTJhyd0AAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQCNWTVQBMm',
  'FJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyY',
  'QC6HeXxtLyFe1a87dTjXWcvf2qvR3l8bS8hXtWvO3U411nL39qrrPjh5480/j5EyYUmTDk7oABagNBMmELkwgEdfv09y+/8Ai5B1',
  '+/T3L7/4utH0q9PPc8lHtyqZMKTJhyd0AAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQ',
  'CNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAt',
  'QGgmTCFyYQC6HeXxtLyFe1a87dTjXWcvf2qvR3l8bS8hXtWvO3U411nL39qrrPjh5480/j5EyYUmTDk7oABagNBMmELkwgEdfv09',
  'y+/+LkHX79Pcvv8A4utH0q9PPc8lHtyqZMKTJhyd0AAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQ',
  'GgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJk',
  'wpMmEkAAtQGgmTCFyYQC6HeXxtLyFe1a87dTjXWcvf2qvR3l8bS8hXtWvO3U411nL39qrrPjh5480/j5EyYUmTDk7oABagNBMmEL',
  'kwgEdfv09y+/+LkHX79Pcvv/AIutH0q9PPc8lHtyqZMKTJhyd0AAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkw',
  'pMmEkAAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTC',
  'ARqyaqAJkwpMmEkAAtQGgmTCFyYQC6HeXxtLyFe1a87dTjXWcvf2qvR3l8bS8hXtWvO3U411nL39qrrPjh5480/j5EyYUmTDk7oA',
  'BagNBMmELkwgEdfv09y+/wDi5B1+/T3L7/4utH0q9PPc8lHtyqZMKTJhyd0AAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCA',
  'RqyaqAJkwpMmEkAAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQCNWTVQBMmFJkwkgAFq',
  'A0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQC6HeXxtLyFe1a87dTjXWcvf2qvR3l8bS8hXtWvO3U411nL39qrrPjh5480/j5Ey',
  'YUmTDk7oABagNBMmELkwgEdfv09y+/8Ai5B1+/T3L7/4utH0q9PPc8lHtyqZMKTJhyd0AAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA',
  '0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQCNWTVQBMm',
  'FJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQC6HeXxtLyFe1a87dTjXWcvf2qvR3l8bS8hXtWvO3U411nL39qrrPjh',
  '5480/j5EyYUmTDk7oABagNBMmELkwgEdfv09y+/+LkHX79Pcvv8A4utH0q9PPc8lHtyqZMKTJhyd0AAtQGgmTCFyYQCNWTVQBMmF',
  'JkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQ',
  'CNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQC6HeXxtLyFe1a87dTjXWcvf2qvR3l8bS8hXtWvO3U411n',
  'L39qrrPjh5480/j5EyYUmTDk7oABagNBMmELkwgEdfv09y+/+LkHX79Pcvv/AIutH0q9PPc8lHtyqZMKTJhyd0AAtQGgmTCFyYQC',
  'NWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQ',
  'GgmTCFyYQCNWTVQBMmFJkwkgAFqA0EyYQuTCARqyaqAJkwpMmEkAAtQGgmTCFyYQC6HeXxtLyFe1a87dTjXWcvf2qvR3l8bS8hXt',
  'WvO3U411nL39qrrPjh5480/j5EyYUmTDk7oABagNBMmELkwgEdfv09y+/wDi5B32+HcmfdT+n8xfFb5rytvl1rT27P8AVK/6drcT',
  'NFUR/jzXqopuUTP+uGTJh0PBPXfF03Ou7k3b0tfXZ+tpudd+LO1Xhvft5c6Oh4Ia/wCNpedd+JwQ1/xtLzrvxG1Xhb9vLwx7/BPX',
  'fF03Ou7jgnrvi6bnXdzW1Xgb9vLnpMIdFdvS19dn62m5134vzghr/jaXnXfiNqvB37eXPNXucENf8bS8678V8E9d8XTc67uUWq8L',
  'ft5eAmTDoeCeu+Lpudd3Ju3pa+uz9bTc678VtV4W/by50dDwQ1/xtLzrvxOCGv8AjaXnXfiNqvC37eXhj3+Ceu+Lpudd3HBPXfF0',
  '3Ou7mtqvA37eXPSYQ6K7elr67P1tNzrvxfnBDX/G0vOu/EbVeDv28ueavc4Ia/42l5134r4J674um513cotV4W/by8BMmHQ8E9d8',
  'XTc67uTdvS19dn62m5134rarwt+3lzo6Hghr/jaXnXficENf8bS8678RtV4W/by8Me/wT13xdNzru44J674um513c1tV4G/by56T',
  'CHRXb0tfXZ+tpudd+L84Ia/42l5134jarwd+3lzzV7nBDX/G0vOu/FfBPXfF03Ou7lFqvC37eXgJkw6Hgnrvi6bnXdybt6Wvrs/W',
  '03Ou/FbVeFv28udHQ8ENf8bS8678Tghr/jaXnXfiNqvC37eXhj3+Ceu+Lpudd3HBPXfF03Ou7mtqvA37eXPSYQ6K7elr67P1tNzr',
  'vxfnBDX/ABtLzrvxG1Xg79vLnmr3OCGv+Npedd+K+Ceu+Lpudd3KLVeFv28vATJh0PBPXfF03Ou7k3b0tfXZ+tpudd+K2q8Lft5c',
  '6Oh4Ia/42l5134nBDX/G0vOu/EbVeFv28vDHv8E9d8XTc67uOCeu+Lpudd3NbVeBv28uekwh0V29LX12frabnXfi/OCGv+Npedd+',
  'I2q8Hft5c81e5wQ1/wAbS8678V8E9d8XTc67uUWq8Lft5eAmTDoeCeu+Lpudd3Ju3pa+uz9bTc678VtV4W/by50dDwQ1/wAbS867',
  '8Tghr/jaXnXfiNqvC37eXhj3+Ceu+Lpudd3HBPXfF03Ou7mtqvA37eXPSYQ6K7elr67P1tNzrvxfnBDX/G0vOu/EbVeDv28ueavc',
  '4Ia/42l5134r4J674um513cotV4W/by8BMmHQ8E9d8XTc67uTdvS19dn62m5134rarwt+3lzo6Hghr/jaXnXficENf8AG0vOu/Eb',
  'VeFv28vDHv8ABPXfF03Ou7jgnrvi6bnXdzW1Xgb9vLnpMIdFdvS19dn62m5134vzghr/AI2l5134jarwd+3k3l8bS8hXtWvO3U41',
  '1nL39qrpd7+4Wq3L11808kN1t0dbKUsrWtdu2lc0p/pzW6nGus5e/tVaqpmmiIlzoqiq7Mxh8iZMKTJhxelAALUBoJkwhcmEAj0P',
  'SWu+d1PS3d7z2piZhmYif6+v0lrvndT0t3ei/dPX02f5up6W7vfOmTB1TkaacPo9J6/57VdNd3npPX/Parpru98gNU5OmnD0PSWu',
  '+d1PS3d56S13zup6W7vfIHVORppw+i/dPX02f5up6W7vT6T1/wA9qumu73zyYQNU5OmnD6/Sev8AntV013e19Ja753U9Ld3vPaqK',
  'pytNOH1+ktd87qelu70X7p6+mz/N1PS3d750yYOqcjTTh9HpPX/Parpru89J6/57VdNd3vkBqnJ004eh6S13zup6W7vPSWu+d1PS',
  '3d75A6pyNNOH0X7p6+mz/N1PS3d6fSev+e1XTXd755MIGqcnTTh9fpPX/Parpru9r6S13zup6W7vee1UVTlaacPr9Ja753U9Ld3o',
  'v3T19Nn+bqelu73zpkwdU5GmnD6PSev+e1XTXd56T1/z2q6a7vfIDVOTppw9D0lrvndT0t3eektd87qelu73yB1TkaacPov3T19N',
  'n+bqelu70+k9f89qumu73zyYQNU5OmnD6/Sev+e1XTXd7X0lrvndT0t3e89qoqnK004fX6S13zup6W7vRfunr6bP83U9Ld3vnTJg',
  '6pyNNOH0ek9f89qumu7z0nr/AJ7VdNd3vkBqnJ004eh6S13zup6W7vPSWu+d1PS3d75A6pyNNOH0X7p6+mz/ADdT0t3en0nr/ntV',
  '013e+eTCBqnJ004fX6T1/wA9qumu72vpLXfO6npbu957VRVOVppw+v0lrvndT0t3ei/dPX02f5up6W7vfOmTB1TkaacPo9J6/wCe',
  '1XTXd56T1/z2q6a7vfIDVOTppw9D0lrvndT0t3eektd87qelu73yB1TkaacPov3T19Nn+bqelu70+k9f89qumu73zyYQNU5OmnD6',
  '/Sev+e1XTXd7X0lrvndT0t3e89qoqnK004fX6S13zup6W7vRfunr6bP83U9Ld3vnTJg6pyNNOH0ek9f89qumu7z0nr/ntV013e+Q',
  'GqcnTTh6HpLXfO6npbu89Ja753U9Ld3vkDqnI004fRfunr6bP83U9Ld3p9J6/wCe1XTXd755MIGqcnTTh9fpPX/Parpru9r6S13z',
  'up6W7vee1UVTlaacPr9Ja753U9Ld3ov3T19Nn+bqelu73zpkwdU5GmnD6PSev+e1XTXd56T1/wA9qumu73yA1Tk6acPQ9Ja753U9',
  'Ld3npLXfO6npbu98gdU5GmnD6L909fTZ/m6npbu9PpPX/Parpru988mEDVOTppw+v0nr/ntV013ezvuuvvuvvurdddXbWta7a1qw',
  'ar5mV8RH8EyYUmTAKAAWoDQTJhC5MIBGrJqoAmTCkyYSQAC1AaCZMIXJhAI1ZNVAEyYUmTCSAAWoDQTJhC5MIBGrJqoAmTCkyYSQ',
  'AC1AaCZMIXJhAI1ZNVAEyYUmTCSAAWoDQTJhC5MIBGrJqoAmTCkyYSQAC1AaCZMIXJhAI1ZNVAEyYUmTCSAAWoDQTJhC5MIBGrJq',
  'oAmTCkyYSQAC1AaCZMIXJhAI1ZNVAEyYUmTCSAAWoDQTJhAAjUFAEyYBJAALUBoJkwgARqCgCZMAkgAFqA0EyYQAI1BQBMmASQAC',
  '1AaCZMIAEagoAmTAJIABagNBMmEACNQUATJgEkAAtQGgmTCABGoKAJkwCSAAWoDQTJhAAjUFAEyYBJAALUBoJkwgARqCgCZMAkgA',
  'F//Z',
].join('');

/** A real JPEG every media-socket test pushes as "one complete frame". */
export const CANNED_JPEG = Buffer.from(CANNED_JPEG_BASE64, 'base64');

/** Width/height of CANNED_JPEG, read from its SOF0 segment. */
export const CANNED_SIZE = { width: 640, height: 360 };

/* ------------------------------------------------------------- utilities */

const SALT = 'RADXA_FIXED_SALT_v1';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function saltedHash(password) {
  return createHash('sha256').update(SALT + String(password ?? ''), 'utf8').digest('hex');
}

function acceptKey(key) {
  return createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Server → client frame (never masked). */
function encodeServerFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, body]);
}

/** Client → server frames arrive masked; reassemble them (fragments included). */
function createFrameParser(onMessage, onControl) {
  let pending = Buffer.alloc(0);
  let fragments = [];
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (pending.length < 2) return;
      const first = pending[0];
      const second = pending[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (pending.length < offset + 2) return;
        length = pending.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (pending.length < offset + 8) return;
        length = Number(pending.readBigUInt64BE(offset));
        offset += 8;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (pending.length < offset + length) return;
      let payload = pending.subarray(offset, offset + length);
      if (masked) {
        const mask = pending.subarray(maskOffset, maskOffset + 4);
        const out = Buffer.alloc(length);
        for (let i = 0; i < length; i += 1) out[i] = payload[i] ^ mask[i % 4];
        payload = out;
      } else {
        payload = Buffer.from(payload);
      }
      pending = pending.subarray(offset + length);

      if (opcode === 0x8) {
        onControl('close', payload);
        return;
      }
      if (opcode === 0x9) {
        onControl('ping', payload);
        continue;
      }
      if (opcode === 0xa) {
        onControl('pong', payload);
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        fragments = [payload];
        if (fin) {
          onMessage(Buffer.concat(fragments));
          fragments = [];
        }
        continue;
      }
      if (opcode === 0x0) {
        fragments.push(payload);
        if (fin) {
          onMessage(Buffer.concat(fragments));
          fragments = [];
        }
      }
    }
  };
}

/** One ws-media message: 25-byte header + payload (CONTRACT.md §7.1). */
export function buildWsMediaPacket(payload, { mediaType = 1, ptsUs = 0n, durationUs = 0n } = {}) {
  const body = Buffer.from(payload);
  const head = Buffer.alloc(25);
  head[0] = mediaType;
  head.writeBigInt64BE(BigInt(ptsUs), 1);
  head.writeBigUInt64BE(BigInt(durationUs), 9);
  head.writeBigUInt64BE(BigInt(body.length), 17);
  return Buffer.concat([head, body]);
}

/** Split an AnnexB byte stream at its start codes (one NAL unit per entry). */
export function annexBUnits(buffer) {
  const buf = Buffer.from(buffer ?? []);
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (buf[i] !== 0 || buf[i + 1] !== 0) continue;
    if (buf[i + 2] === 1) {
      starts.push(i);
      i += 2;
    } else if (buf[i + 2] === 0 && i + 3 < buf.length && buf[i + 3] === 1) {
      starts.push(i);
      i += 3;
    }
  }
  if (starts.length === 0) return buf.length > 0 ? [buf] : [];
  return starts.map((start, index) =>
    buf.subarray(start, index + 1 < starts.length ? starts[index + 1] : buf.length),
  );
}

/* ------------------------------------------------------------ fake device */

/**
 * @param {{
 *   username?: string, password?: string, initialCodec?: number,
 *   frameIntervalMs?: number, deviceName?: string, model?: string, sn?: string,
 *   version?: string, pasteFails?: boolean, tokenTtlMs?: number,
 * }} [options]
 */
export function createFakeDevice(options = {}) {
  const config = {
    username: 'tester',
    password: 's3cret',
    initialCodec: 0,
    frameIntervalMs: 40,
    deviceName: 'Fake Linkr',
    model: 'Radxa Linkr (fake)',
    sn: 'FAKE-0001',
    version: '1.6.0-fake',
    pasteFails: false,
    tokenTtlMs: 10000,
    /** AnnexB H.264 clip (Buffer) served as ws-media packets while the mode is 2. */
    h264Clip: null,
    /** Packet cadence of the H.264 stream; 19 ms ~= the device's 52 packets/s. */
    h264PacketIntervalMs: 19,
    ...options,
  };

  const tokens = new Map(); // token -> expiresAt
  const sockets = new Set();
  const frameTimers = new Set();
  const mediaSockets = new Set();

  const state = {
    codec: config.initialCodec,
    logins: 0,
    codecWrites: [],
    hidFrames: [],
    pastes: [],
    whepCalls: 0,
    requests: [],
    frameIntervalMs: config.frameIntervalMs,
    frame: CANNED_JPEG,
    upgradeAttempts: 0,
    packetsSent: 0,
    h264Units: [],
  };
  if (config.h264Clip) {
    state.h264Units = annexBUnits(config.h264Clip);
    state.h264PacketIntervalMs = config.h264PacketIntervalMs;
  }

  function issueToken() {
    const token = `fake-${randomBytes(9).toString('hex')}`;
    tokens.set(token, Date.now() + config.tokenTtlMs);
    return token;
  }

  function tokenValid(token) {
    const expiresAt = tokens.get(token);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
      tokens.delete(token);
      return false;
    }
    return true;
  }

  function bearer(req) {
    const header = String(req.headers.authorization ?? '');
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1].trim() : '';
  }

  function json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function ok(res, data = {}) {
    json(res, 200, { code: 0, message: '', data });
  }

  function forbidden(res, path) {
    state.requests.push({ method: 'DENIED', path, status: 403 });
    json(res, 403, { code: 403, message: 'No Permisson' });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://fake.invalid');
    const path = url.pathname;
    const method = String(req.method ?? 'GET').toUpperCase();
    state.requests.push({ method, path, status: 0 });
    const last = state.requests[state.requests.length - 1];
    res.on('finish', () => {
      last.status = res.statusCode;
    });

    // Unauthenticated device identity (rate limited by the firmware, ~2/s).
    if (path === '/linkr/info' && method === 'GET') {
      res.setHeader('X-Rate-Limit-Limit', '2');
      ok(res, {
        deviceName: config.deviceName,
        status: 'online',
        onlineTime: 4242,
        heartbeat: Math.floor(Date.now() / 1000),
        version: config.version,
      });
      return;
    }

    if (path === '/api/account/login' && method === 'POST') {
      const body = parseJson(await readBody(req)) ?? {};
      if (config.loginDelayMs) await new Promise(resolve => setTimeout(resolve, config.loginDelayMs));
      if (body.username !== config.username || body.passwd !== saltedHash(config.password)) {
        forbidden(res, path);
        return;
      }
      state.logins += 1;
      ok(res, { token: issueToken(), require_two_factor: false });
      return;
    }

    // Everything below needs a Bearer token.
    if (path.startsWith('/api/')) {
      const token = bearer(req);
      if (!tokenValid(token)) {
        forbidden(res, path);
        return;
      }
    }

    switch (`${method} ${path}`) {
      case 'GET /api/device/info':
        ok(res, {
          model: config.model,
          sn: config.sn,
          eth0_mac: '02:00:00:00:00:01',
          wlan0_mac: '02:00:00:00:00:02',
          wlan1_mac: '02:00:00:00:00:03',
          domain_name: 'fake.local',
        });
        return;
      case 'GET /api/device/version':
        ok(res, { version: config.version });
        return;
      case 'GET /api/account/info':
        ok(res, { username: config.username });
        return;
      case 'GET /api/video/codec':
        ok(res, { video_codec: state.codec });
        return;
      case 'POST /api/video/codec': {
        const body = parseJson(await readBody(req)) ?? {};
        const value = body.video_codec;
        if (!Number.isInteger(value)) {
          json(res, 200, { code: 1, message: 'video_codec must be an integer', data: {} });
          return;
        }
        if (state.codecWriteFails === true) {
          json(res, 500, { code: 1, message: 'video_codec write failed (injected)', data: {} });
          return;
        }
        state.codecWrites.push({ video_codec: value, at: Date.now() });
        state.codec = value;
        ok(res, {});
        return;
      }
      case 'POST /api/rtc/whep': {
        const body = parseJson(await readBody(req)) ?? {};
        state.whepCalls += 1;
        const wanted = body.offer === 'ws_h264' ? 2 : body.offer === 'ws_mjpeg' ? 1 : 0;
        const h264Ready = wanted === 2 && state.codec === 2 && state.h264Units.length > 0;
        if (!wanted || (wanted !== state.codec) || (wanted === 2 && !h264Ready)) {
          // The device answers a mode it cannot serve with this exact message.
          json(res, 200, {
            code: 1,
            message:
              'called Whep with error: rpc error: code = Internal desc = Internal error',
            data: {},
          });
          return;
        }
        ok(res, { answer: issueToken(), stream_id: 42 });
        return;
      }
      case 'POST /api/paste': {
        const body = parseJson(await readBody(req)) ?? {};
        if (config.pasteFails) {
          json(res, 200, { code: 1, message: 'paste is not available', data: {} });
          return;
        }
        state.pastes.push(String(body.text ?? ''));
        ok(res, {});
        return;
      }
      default:
        json(res, 404, { code: 404, message: 'not found', data: {} });
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      json(res, 500, { code: 500, message: String(error?.message ?? error), data: {} });
    });
  });

  server.on('upgrade', (req, socket) => {
    state.upgradeAttempts += 1;
    const url = new URL(req.url, 'http://fake.invalid');
    const token = url.searchParams.get('authorization') ?? '';
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const key = req.headers['sec-websocket-key'];

    if (url.pathname !== '/ws/media' || !key || !tokenValid(token)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!protocols.includes('ws-media')) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      'Sec-WebSocket-Protocol: ws-media',
      '',
      '',
    ];
    socket.write(headers.join('\r\n'));
    sockets.add(socket);
    mediaSockets.add(socket);

    const parser = createFrameParser(
      (payload) => {
        // One binary message from the client is one HID frame.
        state.hidFrames.push(payload);
      },
      (kind, payload) => {
        if (kind === 'close') {
          try {
            socket.write(encodeServerFrame(0x8, payload.subarray(0, 2)));
          } catch {
            // socket already gone
          }
          socket.end();
        } else if (kind === 'ping') {
          try {
            socket.write(encodeServerFrame(0xa, payload));
          } catch {
            // ignore
          }
        }
      },
    );

    socket.on('data', (chunk) => {
      try {
        parser(chunk);
      } catch {
        socket.destroy();
      }
    });
    socket.on('error', () => {
      sockets.delete(socket);
      mediaSockets.delete(socket);
    });
    socket.on('close', () => {
      sockets.delete(socket);
      mediaSockets.delete(socket);
    });

    // Which stream this socket carries is decided by the device mode it was opened in.
    if (state.codec === 2 && state.h264Units.length > 0) {
      const interval = Math.max(5, state.h264PacketIntervalMs ?? 19);
      const units = state.h264Units;
      let index = 0;
      let ptsUs = 0n;
      const pushPacket = () => {
        if (!mediaSockets.has(socket)) return;
        const unit = units[index % units.length];
        index += 1;
        const packet = buildWsMediaPacket(unit, {
          mediaType: 1,
          ptsUs,
          durationUs: BigInt(interval) * 1000n,
        });
        ptsUs += BigInt(interval) * 1000n;
        state.packetsSent += 1;
        try {
          socket.write(encodeServerFrame(0x2, packet));
        } catch {
          // ignore, close handler cleans up
        }
      };
      pushPacket();
      const timer = setInterval(pushPacket, interval);
      timer.unref?.();
      frameTimers.add(timer);
      socket.on('close', () => {
        clearInterval(timer);
        frameTimers.delete(timer);
      });
      return;
    }

    const pushFrame = () => {
      if (!mediaSockets.has(socket)) return;
      try {
        socket.write(encodeServerFrame(0x2, state.frame));
      } catch {
        // ignore, close handler cleans up
      }
    };
    pushFrame();
    const timer = setInterval(pushFrame, Math.max(5, state.frameIntervalMs));
    timer.unref?.();
    frameTimers.add(timer);
    socket.on('close', () => {
      clearInterval(timer);
      frameTimers.delete(timer);
    });
  });

  return {
    /** HTTP origin, available after listen(). */
    origin: '',
    /** Live protocol state for assertions. */
    state,
    config,
    /** Convenience getters over `state`. */
    get codec() {
      return state.codec;
    },
    get codecWrites() {
      return state.codecWrites;
    },
    /** Inject a failing POST /api/video/codec (the device drops the write). */
    get codecWriteFails() {
      return state.codecWriteFails === true;
    },
    set codecWriteFails(value) {
      state.codecWriteFails = value === true;
    },
    get hidFrames() {
      return state.hidFrames;
    },
    get pastes() {
      return state.pastes;
    },
    get whepCalls() {
      return state.whepCalls;
    },
    get packetsSent() {
      return state.packetsSent;
    },
    /** Install the H.264 clip served while the mode is 2. */
    setH264Clip(buffer) {
      config.h264Clip = buffer ?? null;
      state.h264Units = buffer ? annexBUnits(buffer) : [];
    },
    get h264Units() {
      return state.h264Units;
    },
    get logins() {
      return state.logins;
    },
    get requests() {
      return state.requests;
    },
    get frameIntervalMs() {
      return state.frameIntervalMs;
    },
    set frameIntervalMs(value) {
      state.frameIntervalMs = Number(value) || 40;
    },
    /** Force every issued token to expire: the next authed call sees HTTP 403. */
    expireTokens() {
      tokens.clear();
    },
    /** Number of open media sockets (for close/dispose checks). */
    get openMediaSockets() {
      return mediaSockets.size;
    },
    /** Slap the media sockets shut, as a device reboot or Wi-Fi drop would. */
    dropMediaSockets() {
      for (const socket of mediaSockets) {
        try {
          socket.destroy();
        } catch {
          // already gone
        }
      }
      mediaSockets.clear();
    },
    setCodec(value) {
      state.codec = value;
    },
    /** Resolve once `count` HID frames have arrived (or reject after timeoutMs). */
    async waitForHid(count, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (state.hidFrames.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`fake device: expected ${count} HID frames, got ${state.hidFrames.length}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return state.hidFrames;
    },
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      const address = server.address();
      const origin = `http://127.0.0.1:${address.port}`;
      this.origin = origin;
      return origin;
    },
    async close() {
      for (const timer of frameTimers) clearInterval(timer);
      frameTimers.clear();
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }
      sockets.clear();
      mediaSockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
