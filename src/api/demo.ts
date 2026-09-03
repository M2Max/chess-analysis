import type { Game } from "./games";

/**
 * Built-in demo game (the Opera Game, Morphy 1858) used by the `?demo` route.
 * Lets the whole review flow run offline - useful when the games
 * endpoint is having its transient "Data provider not found" days.
 */
export const DEMO_GAME: Game = {
  id: "demo-opera-game",
  url: "https://en.wikipedia.org/wiki/Opera_Game",
  utc: Math.floor(Date.UTC(1858, 0, 1) / 1000),
  white: { name: "Paul Morphy", username: "morphy" },
  black: {
    name: "Duke Karl of Brunswick & Count Isouard",
    username: "dukes",
  },
  result: "1-0",
  variant: "chess",
  timeControl: "casual",
  timeClass: "casual",
  pgn: [
    "[Event \"Opera Game\"]",
    "[Site \"Paris\"]",
    "[Date \"1858.01.01\"]",
    "[White \"Paul Morphy\"]",
    "[Black \"Duke Karl of Brunswick & Count Isouard\"]",
    "[Result \"1-0\"]",
    "",
    "1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7",
    "8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7",
    "14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0",
  ].join("\n"),
};
