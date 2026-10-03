// Acceptance check against the Netflix PT app on 2026-10-02 (spec §7). Needs network (Cinemeta).
const assert = require('assert');
const fs = require('fs');
const { parse, resolve } = require('./update');

(async () => {
  const lists = parse(fs.readFileSync(__dirname + '/fixtures/2026-10-02/fp-netflix.html', 'utf8'));
  assert.deepStrictEqual(lists['TV Shows'].map(x => x.title), ['The Final Problem', 'Habeas Corpus', 'LEGO ONE PIECE', 'Minerva Academy', 'A Different World', 'East of Eden', 'Monster: The Lizzie Borden Story', 'Not a Stranger', 'Shaque: Trust No One', 'The Gentlemen']);
  assert.deepStrictEqual(lists.Movies.map(x => x.title), ['UNABOMBER', "The Widower: 'Til Death Do Us Part", 'How to Lose a Guy in 10 Days', 'Demon Slayer: Kimetsu no Yaiba Infinity Castle', 'Last Vegas', 'Hanging Up', 'White Chicks', 'Best of the Best', 'The Whisper Man', 'Cellular']);

  const ids = {};
  for (const it of lists['TV Shows']) ids[it.title] = (await resolve(it, ['series'], {}))?.id;
  for (const it of lists.Movies) ids[it.title] = (await resolve(it, ['movie'], {}))?.id;
  console.log(ids);

  const known = { 'Monster: The Lizzie Borden Story': 'tt13207736', 'The Gentlemen': 'tt13210838', 'Minerva Academy': 'tt28765828', 'Habeas Corpus': 'tt39369819', 'Not a Stranger': 'tt39397536', 'The Final Problem': 'tt36832679', UNABOMBER: 'tt6933238', 'The Whisper Man': 'tt11561116' };
  for (const [title, id] of Object.entries(known)) assert.strictEqual(ids[title], id, title);
  console.log('ok');
})();
