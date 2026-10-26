import { readFile } from 'node:fs/promises';

const annotations = JSON.parse(
  await readFile(new URL('../samples/annotations.json', import.meta.url), 'utf8'),
);
const excluded = annotations.images.filter((image) => image.category_determinate === false);
const evaluations = [];
for (const model of ['mobileclip', 'siglip']) {
  const raw = JSON.parse(
    await readFile(new URL(`../results/${model}.json`, import.meta.url), 'utf8'),
  );
  const determinate = raw.results.filter(
    (result) =>
      !excluded.some((image) => result.image === `${String(image.index).padStart(2, '0')}.jpg`),
  );
  const top1Matches = determinate.filter(
    (result) => result.predictions[0]?.label === result.expected,
  ).length;
  const top5Matches = determinate.filter((result) =>
    result.predictions.slice(0, 5).some((prediction) => prediction.label === result.expected),
  ).length;
  evaluations.push({
    model,
    evaluated: determinate.length,
    top1Matches,
    top5Matches,
    top1: top1Matches / determinate.length,
    top5: top5Matches / determinate.length,
  });
}
console.log(
  JSON.stringify(
    {
      method:
        'Post-review category scoring. Original model predictions and timings are unchanged; categories marked indeterminate are excluded from both numerator and denominator.',
      excluded: excluded.map((image) => ({
        image: `${String(image.index).padStart(2, '0')}.jpg`,
        reason: image.category_review,
      })),
      evaluations,
    },
    null,
    2,
  ),
);
