import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { fixtures, toDataUrl } from './fixtures.ts';
import { askDecision, evidence, omni, probabilities, request, timeout } from './liveSupport.ts';

before(
  async () => {
    await fixtures();
  },
  { timeout },
);

test(
  'native decisions classify text, estimate a score and distinguish yes from no',
  { timeout },
  async () => {
    const answers = await askDecision(
      'I was charged twice. Refund the duplicate payment today; it is blocking my order.',
      {
        refund: { type: 'noul', instructions: 'Is the customer requesting a refund?' },
        delivery: { type: 'noul', instructions: 'Is the customer asking to change an address?' },
        route: {
          type: 'choice',
          instructions: 'Which team should handle the request?',
          criteria: {
            billing: 'Charges and refunds',
            shipping: 'Delivery',
            technical: 'App faults',
          },
        },
        urgency: {
          type: 'score',
          instructions: 'How urgent is the customer request?',
          criteria: ['Can wait a month', 'Within a week', 'Today', 'Blocking the customer now'],
        },
      },
    );
    assert.ok(answers.refund.noul! > 0.5);
    assert.ok(answers.delivery.noul! < 0.5);
    assert.equal(answers.route.choice, 'billing');
    assert.ok(answers.urgency.score! > 1 && answers.urgency.score! <= 3);
    probabilities(answers.route);
    probabilities(answers.urgency);
    await evidence('decision-text', answers);
  },
);

test('native decisions read JSON game state', { timeout }, async () => {
  const answers = await askDecision(
    { player: { health: 0, lives: 0 }, screen: 'GAME OVER', enemiesRemaining: 4 },
    {
      ended: { type: 'noul', instructions: 'Has the player lost the game?' },
      action: {
        type: 'choice',
        instructions: 'Which action matches the current game state?',
        criteria: {
          restart: 'Restart after losing the game',
          fight: 'Keep fighting while alive',
          victory: 'Celebrate defeating every enemy',
        },
      },
    },
  );
  assert.ok(answers.ended.noul! > 0.5);
  assert.equal(answers.action.choice, 'restart');
  probabilities(answers.action);
  await evidence('decision-game', answers);
});

test('native decisions distinguish threatening and harmless content', { timeout }, async () => {
  const question = {
    threat: { type: 'noul', instructions: 'Does this contain a violent threat?' },
  };
  const harmful = await askDecision('I will shoot everyone in your office tomorrow.', question);
  const harmless = await askDecision('Thank you for fixing my order. Have a lovely day.', question);
  assert.ok(harmful.threat.noul! > 0.5);
  assert.ok(harmless.threat.noul! < 0.5);
  await evidence('decision-moderation', { harmful, harmless });
});

test(
  'native decisions inspect an image and image content inside a state',
  { timeout },
  async () => {
    const image = await toDataUrl((await fixtures()).image, 'image/png');
    const questions = {
      color: {
        type: 'choice',
        instructions: 'What color is the square in the image?',
        criteria: { red: 'Red', blue: 'Blue', green: 'Green' },
      },
    };
    const files = await askDecision(null, questions, { images: [image] });
    const state = await askDecision(
      [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }] }],
      questions,
    );
    assert.equal(files.color.choice, 'red');
    assert.equal(state.color.choice, 'red');
    probabilities(files.color);
    await evidence('decision-images', { files, state });
  },
);

test('native decisions understand recorded audio', { timeout }, async () => {
  const audio = await toDataUrl((await fixtures()).audio, 'audio/wav');
  const answers = await askDecision(
    null,
    {
      kind: {
        type: 'choice',
        instructions: 'What kind of audio is this?',
        criteria: { speech: 'A person speaking', music: 'Instrumental music', silence: 'Silence' },
      },
      english: { type: 'noul', instructions: 'Is the speaker speaking English?' },
    },
    { files: [audio] },
  );
  assert.equal(answers.kind.choice, 'speech');
  assert.ok(answers.english.noul! > 0.5);
  probabilities(answers.kind);
  await evidence('decision-audio', answers);
});

test('native decisions understand a video', { timeout }, async () => {
  const video = await toDataUrl((await fixtures()).video, 'video/mp4');
  const answers = await askDecision(
    null,
    {
      activity: {
        type: 'choice',
        instructions: 'What is the child doing?',
        criteria: { reading: 'Reading a book', eating: 'Eating food', sleeping: 'Sleeping' },
      },
    },
    { files: [video] },
  );
  assert.equal(answers.activity.choice, 'reading');
  probabilities(answers.activity);
  await evidence('decision-video', answers);
});

test('native decisions answer a spoken question', { timeout }, async () => {
  const response = await request('/tts', {
    model: omni,
    input: 'Is the customer asking for a refund?',
    lang: 'en',
    voice: 'female',
    seed: 17,
  });
  const audio = Buffer.from(await response.arrayBuffer());
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.ok(audio.length > 4_800, 'Spoken question must contain audio samples');
  const answers = await askDecision(
    'I paid twice for the same order. Please give me my money back.',
    {
      refund: {
        type: 'noul',
        instructions: {
          type: 'input_audio',
          input_audio: { data: audio.toString('base64'), format: 'wav' },
        },
      },
    },
  );
  assert.ok(answers.refund.noul! > 0.5);
  await evidence('decision-spoken-question', answers);
});
