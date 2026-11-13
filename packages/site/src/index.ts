import { MACHINE_STATES, type MachineEvent, type MachineTimes } from "@mark1russell7/runner-dispatch";
import { byId, copyText, setupTheme } from "@mark1russell7/site-pages/chrome";
import {
  choices,
  duration,
  judge,
  longest,
  noteOf,
  readTimes,
  SAMPLE_RULES,
  SAMPLE_TIMES,
  SCENARIOS,
  send,
  startSim,
  TIME_FIELDS,
  timerOf,
  visited,
  waitForTimer,
  type RunFields,
  type Sim,
} from "./demo.ts";

setupTheme(byId<HTMLButtonElement>("theme"), "theme");

const copy = byId<HTMLButtonElement>("copy");
copy.addEventListener("click", () => {
  void copyText(copy, byId("install").textContent ?? "");
});

/** This function makes an element with a class and a text. It never parses HTML, so a field of the visitor stays text. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

const code = (text: string): HTMLElement => el("code", "", text);

function listOf(target: HTMLElement, items: readonly string[]): void {
  target.replaceChildren(...items.map((item) => el("li", "", item)));
}

// The trust demo.

const TEXT_FIELDS = ["repository", "event", "headRepository", "actor", "triggeringActor"] as const;
const inputs = Object.fromEntries(TEXT_FIELDS.map((key) => [key, byId<HTMLInputElement>(`f-${key}`)])) as Record<
  (typeof TEXT_FIELDS)[number],
  HTMLInputElement
>;
const attempt = byId<HTMLInputElement>("f-attempt");
const rulesBox = byId<HTMLTextAreaElement>("rules");
const rulesProblems = byId("rules-problems");
const verdictBox = byId("verdict");
const checksList = byId("checks");
const scenarioBox = byId("scenarios");

rulesBox.value = JSON.stringify(SAMPLE_RULES, null, 2);

function fields(): RunFields {
  return {
    repository: inputs.repository.value,
    event: inputs.event.value,
    headRepository: inputs.headRepository.value,
    actor: inputs.actor.value,
    triggeringActor: inputs.triggeringActor.value,
    attempt: Number(attempt.value),
  };
}

function fill(run: RunFields): void {
  for (const key of TEXT_FIELDS) inputs[key].value = run[key];
  attempt.value = String(run.attempt);
}

const sameRun = (a: RunFields, b: RunFields): boolean =>
  TEXT_FIELDS.every((key) => a[key] === b[key]) && a.attempt === b.attempt;

const scenarioButtons = SCENARIOS.map((scenario) => {
  const button = el("button", "chip", scenario.title);
  button.type = "button";
  button.addEventListener("click", () => {
    fill(scenario.run);
    renderTrust();
  });
  return button;
});
scenarioBox.replaceChildren(...scenarioButtons);

function renderTrust(): void {
  const current = fields();
  const verdict = judge(rulesBox.value, current);
  SCENARIOS.forEach((scenario, index) => {
    scenarioButtons[index]?.setAttribute("aria-pressed", String(sameRun(scenario.run, current)));
  });

  if (!verdict.rules.ok) {
    rulesBox.setAttribute("aria-invalid", "true");
    listOf(rulesProblems, verdict.rules.problems);
  } else {
    rulesBox.removeAttribute("aria-invalid");
    rulesProblems.replaceChildren();
  }

  const decision = verdict.decision;
  if (decision === null) {
    verdictBox.className = "verdict blocked";
    verdictBox.replaceChildren(
      el("strong", "", "No decision."),
      document.createTextNode(" The rules have a problem, and the dispatcher does not start with rules that have a problem."),
    );
  } else if (decision.trusted) {
    verdictBox.className = "verdict trusted";
    verdictBox.replaceChildren(
      el("strong", "", "Trusted."),
      document.createTextNode(" The dispatcher makes one machine for each job of this run."),
    );
  } else {
    const count = new Set(decision.refusals.map((refusal) => refusal.rule)).size;
    verdictBox.className = "verdict refused";
    verdictBox.replaceChildren(
      el("strong", "", "Not trusted."),
      document.createTextNode(` The dispatcher makes no machine: ${count === 1 ? "1 rule refuses" : `${count} rules refuse`} the run.`),
    );
  }

  checksList.replaceChildren(
    ...verdict.checks.map((check) => {
      const item = el("li", check.passed ? "passed" : "failed");
      item.append(
        el("span", "sign", check.passed ? "✓" : "✕"),
        el("span", "sr", check.passed ? "Passed: " : "Refused: "),
        el("span", "label", check.label),
      );
      for (const reason of check.reasons) item.append(el("span", "reason", reason));
      return item;
    }),
  );
}

byId("run-form").addEventListener("input", renderTrust);
byId("run-form").addEventListener("submit", (event) => {
  event.preventDefault();
});
rulesBox.addEventListener("input", renderTrust);
fill(SCENARIOS[0]?.run ?? fields());
renderTrust();

// The life demo.

let times: MachineTimes = SAMPLE_TIMES;
let sim: Sim = startSim(times);
let firstTimers = new Set<number>();
let delay = defaultDelay(sim);

const statesList = byId("states");
const stateNote = byId("state-note");
const timerText = byId("timer-text");
const track = byId("track");
const timerWindow = byId("timer-window");
const delayMark = byId("delay-mark");
const delayLabel = byId("delay-label");
const delayInput = byId<HTMLInputElement>("delay");
const delayOut = byId("delay-out");
const eventsBox = byId("events");
const waitButton = byId<HTMLButtonElement>("wait");
const logList = byId("log");
const timesBox = byId("times");
const timesProblems = byId("times-problems");
const longestText = byId("longest");

/** This function gives the first delay of a state: a quarter of the wait of its timer, in seconds. */
function defaultDelay(of: Sim): number {
  const wait = timerOf(of);
  return wait === null ? 0 : Math.round(wait.low / 4000);
}

function restart(): void {
  sim = startSim(times);
  firstTimers = new Set();
  delay = defaultDelay(sim);
  renderLife();
}

function apply(event: MachineEvent): void {
  const sent = send(sim, event, delay * 1000);
  if (sent.timerFirst) firstTimers.add(sent.sim.log.length - 1);
  sim = sent.sim;
  delay = defaultDelay(sim);
  renderLife();
}

function renderTimer(): void {
  const wait = timerOf(sim);
  const hidden = wait === null;
  track.hidden = hidden;
  delayLabel.hidden = hidden;
  delayInput.hidden = hidden;
  if (wait === null) {
    timerText.textContent = "The provider tells that the machine is not there. The life of the machine ended, and no timer runs.";
    return;
  }
  const again = sim.life.state === "done" ? " At each firing, the dispatcher asks again, and the wait doubles up to retryMax." : "";
  timerText.replaceChildren(
    document.createTextNode("The timer "),
    code(wait.timer),
    document.createTextNode(
      ` fires ${duration(wait.low)} after the entry to the state. The dispatcher sees it at its next pass, at most ${duration(wait.high)} after the entry.${again}`,
    ),
  );
  const scale = wait.high * 1.25;
  timerWindow.style.left = `${(wait.low / scale) * 100}%`;
  timerWindow.style.width = `${((wait.high - wait.low) / scale) * 100}%`;
  const max = Math.ceil(scale / 1000);
  delay = Math.min(delay, max);
  delayInput.max = String(max);
  delayInput.value = String(delay);
  const late = delay * 1000 >= wait.low;
  delayMark.style.left = `${((delay * 1000) / scale) * 100}%`;
  delayMark.classList.toggle("late", late);
  delayOut.textContent = `${duration(delay * 1000)}${late ? ": the timer fires first" : ""}`;
}

function renderLife(): void {
  const seen = visited(sim);
  statesList.replaceChildren(
    ...MACHINE_STATES.map((state) => {
      const now = state === sim.life.state;
      const item = el("li", now ? "now" : seen.has(state) ? "seen" : "", state);
      if (now) item.setAttribute("aria-current", "step");
      return item;
    }),
  );
  stateNote.replaceChildren(el("strong", "", sim.life.state), document.createTextNode(`: ${noteOf(sim.life.state)}.`));

  renderTimer();

  const events = choices(sim);
  eventsBox.replaceChildren(
    ...events.map((event) => {
      const button = el("button", "event");
      button.type = "button";
      button.append(code(event), el("span", "hint", noteOf(event)));
      button.addEventListener("click", () => {
        apply(event);
      });
      return button;
    }),
  );
  const wait = timerOf(sim);
  waitButton.disabled = wait === null;
  waitButton.replaceChildren(document.createTextNode("Wait for the timer"));
  if (wait !== null) waitButton.append(document.createTextNode(" "), code(wait.fires));

  if (sim.log.length === 0) {
    listOf(logList, ["The dispatcher asked the provider for the machine. No event came yet."]);
  } else {
    logList.replaceChildren(
      ...sim.log.map((line, index) => {
        const item = el("li");
        item.append(el("span", "time", `+${duration(line.at)}`), code(line.event), el("span", "move", `${line.from} → ${line.to}`));
        if (firstTimers.has(index)) item.append(el("span", "reason", "The timer fired before the event that you sent."));
        for (const action of line.actions) {
          const request = el("span", "request");
          request.append(el("span", "tag", "request"), code(action), document.createTextNode(`: ${noteOf(action)}.`));
          item.append(request);
        }
        return item;
      }),
    );
  }

  const bounds = longest(sim);
  longestText.textContent = `With these times, the work of a machine ends at most ${duration(bounds.withJob)} after the request with a job, and ${duration(bounds.withoutJob)} with no job.`;
}

const timeInputs = TIME_FIELDS.map((field) => {
  const id = `t-${field.key}`;
  const label = el("label");
  label.htmlFor = id;
  label.append(code(field.key), el("span", "hint", field.note));
  const input = el("input");
  input.id = id;
  input.type = "number";
  input.min = "1";
  input.step = "1";
  input.inputMode = "numeric";
  input.value = String(SAMPLE_TIMES[field.key]);
  const row = el("div", "time-field");
  row.append(label, input);
  timesBox.append(row);
  return { key: field.key, input };
});

timesBox.addEventListener("input", () => {
  const values = Object.fromEntries(timeInputs.map(({ key, input }) => [key, Number(input.value)]));
  const read = readTimes(values);
  if (!read.ok) {
    listOf(timesProblems, read.problems);
    return;
  }
  timesProblems.replaceChildren();
  times = read.times;
  restart();
});

delayInput.addEventListener("input", () => {
  delay = Number(delayInput.value);
  renderTimer();
});
waitButton.addEventListener("click", () => {
  sim = waitForTimer(sim);
  delay = defaultDelay(sim);
  renderLife();
});
byId("restart").addEventListener("click", restart);
renderLife();
