// Minimal typings for the parts of clipper-lib (Clipper 6.4.2, Boost Software License) the editor uses.
declare module 'clipper-lib' {
  export interface IntPoint { X: number; Y: number }
  export type Path = IntPoint[];
  export type Paths = Path[];
  export class Clipper {
    constructor(initOptions?: number);
    AddPaths(paths: Paths, polyType: number, closed: boolean): boolean;
    Execute(clipType: number, solution: Paths, subjFillType?: number, clipFillType?: number): boolean;
    static Area(path: Path): number;
    static SimplifyPolygons(polys: Paths, fillType?: number): Paths;
    static CleanPolygons(polys: Paths, distance?: number): Paths;
  }
  export class ClipperOffset {
    constructor(miterLimit?: number, arcTolerance?: number);
    AddPaths(paths: Paths, joinType: number, endType: number): void;
    Execute(solution: Paths, delta: number): void;
  }
  export const ClipType: { ctIntersection: number; ctUnion: number; ctDifference: number; ctXor: number };
  export const PolyType: { ptSubject: number; ptClip: number };
  export const PolyFillType: { pftEvenOdd: number; pftNonZero: number; pftPositive: number; pftNegative: number };
  export const JoinType: { jtSquare: number; jtRound: number; jtMiter: number };
  export const EndType: { etOpenSquare: number; etOpenRound: number; etOpenButt: number; etClosedLine: number; etClosedPolygon: number };
  const ClipperLib: {
    Clipper: typeof Clipper; ClipperOffset: typeof ClipperOffset; ClipType: typeof ClipType; PolyType: typeof PolyType;
    PolyFillType: typeof PolyFillType; JoinType: typeof JoinType; EndType: typeof EndType;
  };
  export default ClipperLib;
}
