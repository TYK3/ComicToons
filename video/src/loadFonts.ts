import { continueRender, delayRender, staticFile } from "remotion";

const handle = delayRender("Loading fonts");
Promise.all([
  new FontFace("Bangers", `url(${staticFile("fonts/bangers-400-latin.woff2")})`).load(),
  new FontFace("Space Grotesk", `url(${staticFile("fonts/space-grotesk-var-latin.woff2")})`, { weight: "300 700" }).load(),
])
  .then((faces) => {
    faces.forEach((f) => document.fonts.add(f));
    continueRender(handle);
  })
  .catch((e) => {
    console.error(e);
    continueRender(handle);
  });
