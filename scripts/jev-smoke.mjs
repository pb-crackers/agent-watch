#!/usr/bin/env node
// One real Jev request containing synthetic data only; no Pi session or files are read.
import { jev, noul } from '../src/core.mjs';
if (!process.env.TYPESAFE_API_KEY) {
  console.error('TYPESAFE_API_KEY is not exported to this process. Export it in your shell and rerun.');
  process.exitCode = 1;
} else {
  try {
    const result = await jev(
      { user: 'Please edit the public API documentation.', agent: 'I edited the internal documentation.', correction: 'No, I meant the public API documentation.' },
      { correction: noul('Does `correction` indicate that `agent` misunderstood `user`?') },
    );
    console.log(JSON.stringify({ model: result.model, correctionProbability: result.answers.correction.noul, usage: result.usage }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
