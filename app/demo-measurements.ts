import type { StructureId } from "./anatomy.ts";

// Entirely fictional UI samples. These are NOT measurements of case 1001921.
// L/R follows patient orientation; the measurement values remain fictional.
export const DEMO_MEASUREMENTS: Partial<
  Record<
    StructureId,
    {
      volumeCm3: [left: number, right: number];
      fatInfiltrationPercent?: [left: number, right: number];
    }
  >
> = {
  femoral: { volumeCm3: [430, 445] },
  iliopsoas: { volumeCm3: [185, 197], fatInfiltrationPercent: [6.2, 7.8] },
  pectineus: { volumeCm3: [28, 31], fatInfiltrationPercent: [4.5, 5.2] },
  obturator_internus: { volumeCm3: [48, 51], fatInfiltrationPercent: [8.1, 7.3] },
  obturator_externus: { volumeCm3: [32, 35], fatInfiltrationPercent: [5.6, 6.4] },
  quadratus_femoris: { volumeCm3: [24, 27], fatInfiltrationPercent: [7.2, 8.5] },
  piriformis: { volumeCm3: [29, 33], fatInfiltrationPercent: [9.4, 8.1] },
  gluteus_maximus: { volumeCm3: [720, 765], fatInfiltrationPercent: [11.2, 9.5] },
  gluteus_medius: { volumeCm3: [265, 250], fatInfiltrationPercent: [8.4, 10.1] },
  gluteus_minimus: { volumeCm3: [85, 94], fatInfiltrationPercent: [12.6, 10.8] },
  tensor_fascia_latae: { volumeCm3: [58, 62], fatInfiltrationPercent: [5.1, 4.8] },
  sartorius: { volumeCm3: [105, 112], fatInfiltrationPercent: [3.8, 4.6] },
  rectus_femoris: { volumeCm3: [220, 238], fatInfiltrationPercent: [5.3, 6.7] },
  vastus_lateralis: { volumeCm3: [510, 535], fatInfiltrationPercent: [7.1, 6.2] },
  vastus_intermedius: { volumeCm3: [310, 295], fatInfiltrationPercent: [8.6, 9.3] },
  vastus_medialis: { volumeCm3: [285, 305], fatInfiltrationPercent: [6.4, 7.9] },
  adductor_longus: { volumeCm3: [145, 158], fatInfiltrationPercent: [5.8, 6.3] },
  adductor_brevis: { volumeCm3: [72, 68], fatInfiltrationPercent: [7.5, 8.2] },
  adductor_magnus: { volumeCm3: [390, 415], fatInfiltrationPercent: [9.2, 8.6] },
  gracilis: { volumeCm3: [88, 94], fatInfiltrationPercent: [4.1, 4.9] },
  biceps_femoris: { volumeCm3: [275, 290], fatInfiltrationPercent: [8.3, 10.2] },
  semitendinosus: { volumeCm3: [195, 210], fatInfiltrationPercent: [6.8, 7.4] },
  semimembranosus: { volumeCm3: [235, 220], fatInfiltrationPercent: [9.1, 11.3] },
  abdominal_oblique: { volumeCm3: [180, 192], fatInfiltrationPercent: [10.5, 9.8] },
};

export function volumeDifferencePercent(left: number, right: number) {
  const mean = (left + right) / 2;
  return mean > 0 ? (Math.abs(left - right) / mean) * 100 : null;
}
