import {test, expect} from "bun:test";
import {estimate, score, type History} from "../estimator/predict";

const target = {area:"screen", kind:"feature", provider:"codex"};
const row = (n: number, value: number): History => ({
  ...target, id:`ticket-${String(n).padStart(3,"0")}`, started:1000+n*1000, completed:1500+n*1000,
  seconds:value, tokens:value*10, elapsed:value*2, imported:false,
});
const improving = () => Array.from({length:50}, (_,n) => row(n,n < 20 ? 100 : n < 44 ? 10 : n-40+.1));
function permutations(rows: History[]): History[][] {
  const result = [[...rows].reverse(), [...rows.slice(17), ...rows.slice(0,17)]];
  let seed = 41;
  for (let n=0; n<12; n++) {
    const shuffled = [...rows];
    for (let i=shuffled.length-1; i>0; i--) {
      seed = (Math.imul(seed,1664525)+1013904223) >>> 0;
      const j = seed % (i+1);
      [shuffled[i],shuffled[j]] = [shuffled[j],shuffled[i]];
    }
    result.push(shuffled);
  }
  return result;
}

test("direct exports give identical promoted forecasts and scores for permutations without mutation", () => {
  const rows = improving(), evaluation = score(rows), forecast = estimate(rows,target,100000);
  expect(evaluation.status).toBe("better");
  expect(evaluation.errors.seconds.count).toBeGreaterThanOrEqual(20);
  expect(forecast.method).toBe("recent-five");
  expect(forecast.helperHours).toBeCloseTo(7.1/3600,12);
  expect(forecast.tokens).toBeCloseTo(71,12);
  expect(forecast.elapsedHours).toBeCloseTo(14.2/3600,12);
  for (const input of [rows,...permutations(rows)]) {
    const before = structuredClone(input);
    input.forEach(Object.freeze);
    Object.freeze(input);
    expect(score(input)).toEqual(evaluation);
    expect(estimate(input,target,100000)).toEqual(forecast);
    expect(input).toEqual(before);
  }
});

test("completion ties select the last five record IDs deterministically", () => {
  const tied = Array.from({length:7}, (_,n) => ({
    ...row(60+n,n+1), id:`tie-${String.fromCharCode(97+n)}`, started:59000, completed:60000,
  }));
  const rows = [...improving(),...tied], evaluation = score(rows), forecast = estimate(rows,target,100000);
  expect(forecast.method).toBe("recent-five");
  // c through g win the seven-way completion tie: (3+4+5+6+7)/5.
  expect(forecast.helperHours).toBe(5/3600);
  expect(forecast.tokens).toBe(50);
  expect(forecast.elapsedHours).toBe(10/3600);
  for (const input of permutations(rows)) {
    expect(score(input)).toEqual(evaluation);
    expect(estimate(input,target,100000)).toEqual(forecast);
  }
});

test("duplicate IDs at the same completion still have a deterministic ordering", () => {
  const tied = Array.from({length:7}, (_,n) => ({
    ...row(60,n+1), id:"duplicate", started:59000, completed:60000,
  }));
  const rows = [...improving(),...tied], evaluation = score(rows), forecast = estimate(rows,target,100000);
  expect(forecast.method).toBe("recent-five");
  expect(forecast.helperHours).toBe(5/3600);
  for (const input of permutations(rows)) {
    expect(score(input)).toEqual(evaluation);
    expect(estimate(input,target,100000)).toEqual(forecast);
  }
});

test("promoted forecasts exclude equal-start completions, overlapping, future and imported rows", () => {
  const rows = improving(), at = 60000, forecast = estimate(rows,target,at);
  expect(forecast.method).toBe("recent-five");
  const excluded = [
    {...row(60,1e9),started:1,completed:at},
    {...row(61,1e9),started:1,completed:at+1},
    {...row(62,1e9),started:at+1,completed:at+1000},
    {...row(63,1e9),started:1,completed:55000,imported:true},
    {...row(64,1e9),started:1,completed:55000,provider:"claude"},
  ];
  for (const input of permutations([...rows,...excluded])) {
    expect(estimate(input,target,at)).toEqual(forecast);
  }
});

test("held-out evaluation strictly excludes rows completing at or after each target start", () => {
  const rows = [...Array.from({length:6}, (_,n) => row(n,100)),
    {...row(10,10),started:10000,completed:20000}];
  const evaluation = score(rows);
  expect(evaluation.errors.seconds).toEqual({count:2,candidate:90,mean:90});
  const excluded = [10000,10001,30000].map((completed,n) => ({
    ...row(70+n,1e9),started:1,completed,
  }));
  for (const input of permutations([...rows,...excluded])) expect(score(input)).toEqual(evaluation);
});

test("dimension-specific comparable and provider fallback preserve unknown tokens", () => {
  const rows = improving().map(r => ({...r,tokens:null}));
  const evaluation = score(improving());
  expect(evaluation.status).toBe("better");
  const other = Array.from({length:7}, (_,n) => ({...row(60+n,n+1),area:"other"}));
  const input = [...rows,...other,{...row(80,1e9),provider:"claude"}];
  const forecast = estimate(input,target,100000,evaluation);
  expect(forecast.method).toBe("recent-five");
  expect(forecast.helperHours).toBeCloseTo(7.1/3600,12);
  // No comparable token measurements: use the provider's five newest known values.
  expect(forecast.tokens).toBe(50);
  expect(estimate(rows,target,100000,evaluation).tokens).toBeNull();
  expect(estimate(input,{...target,area:"missing"},100000,evaluation).helperHours).toBe(5/3600);
  expect(estimate(input,{...target,provider:"unknown"},100000,evaluation).helperHours).toBeNull();
  for (const shuffled of permutations(input)) expect(estimate(shuffled,target,100000,evaluation)).toEqual(forecast);
  expect(estimate(Array.from({length:50}, (_,n) => row(n,10)),target,100000).method).toBe("mean");
});
