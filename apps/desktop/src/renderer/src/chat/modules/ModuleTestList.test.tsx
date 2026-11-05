import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ModuleTestCase, ModuleTestRun } from "@eo/core";
import { CoverageBadge, coverageTone } from "./CoverageBadge";
import { ModuleTestList } from "./ModuleTestList";
import { NotFullyTested } from "./NotFullyTested";

/**
 * The pieces the module page and the approval card show (EO-354), in the
 * chat layout: the case list, the coverage badge and "Not fully tested".
 */

function testCase(id: string, description: string): ModuleTestCase {
  return { id, moduleId: "m1", description, source: `export default async function (harness) { /* ${description} */ }`, createdAt: 0, updatedAt: 0 };
}

const MERGES = testCase("t1", "merges once CI is green");
const WAITS = testCase("t2", "waits while CI runs");
const NEW = testCase("t3", "refuses a draft pull request");

function run(lines: number, branches = 50): ModuleTestRun {
  return {
    ranAt: 1,
    cases: [
      { testId: "t1", description: MERGES.description, passed: true, failure: null, durationMs: 4, output: "" },
      { testId: "t2", description: WAITS.description, passed: false, failure: "Expected values to be strictly equal:\n\n'merged' !== 'waiting'", durationMs: 4, output: "" },
    ],
    coverage: { lines: { covered: lines, total: 100, percent: lines }, branches: { covered: branches, total: 100, percent: branches } },
  };
}

describe("the test list", () => {
  it("lists every case by description with passed, failed or not run", () => {
    render(<ModuleTestList tests={[MERGES, WAITS, NEW]} run={run(90)} stale={false} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Passed");
    expect(rows[0]).toHaveTextContent(MERGES.description);
    expect(rows[1]).toHaveTextContent("Failed");
    expect(rows[2]).toHaveTextContent("Not run");
  });

  it("reads every case as not run when the run is about older code", () => {
    render(<ModuleTestList tests={[MERGES, WAITS]} run={run(90)} stale />);
    expect(screen.getAllByText("Not run")).toHaveLength(2);
    expect(screen.queryByText("Passed")).not.toBeInTheDocument();
  });

  it("says so when there are no cases", () => {
    render(<ModuleTestList tests={[]} run={null} stale={false} />);
    expect(screen.getByText("No test cases yet.")).toBeInTheDocument();
  });

  it("opens a case to its source, read-only, and a failed one to its failure", () => {
    render(<ModuleTestList tests={[MERGES, WAITS]} run={run(90)} stale={false} />);

    fireEvent.click(screen.getByRole("button", { name: /merges once CI is green/, expanded: false }));
    expect(screen.getByLabelText(`Source of ${MERGES.description}`)).toHaveTextContent(MERGES.source);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(`Failure of ${MERGES.description}`)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /waits while CI runs/ }));
    expect(screen.getByLabelText(`Failure of ${WAITS.description}`)).toHaveTextContent("'merged' !== 'waiting'");
    expect(screen.getByLabelText(`Source of ${WAITS.description}`)).toHaveTextContent(WAITS.source);
  });

  it("deletes a case on the second click, and offers no delete when it is only being read", () => {
    const onDelete = vi.fn();
    const { unmount } = render(<ModuleTestList tests={[MERGES]} run={null} stale={false} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: `Delete ${MERGES.description}` }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: `Confirm deleting ${MERGES.description}` }));
    expect(onDelete).toHaveBeenCalledWith(MERGES);
    unmount();

    render(<ModuleTestList tests={[MERGES]} run={null} stale={false} />);
    expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
  });

  it("disarms a delete when focus leaves it", () => {
    const onDelete = vi.fn();
    render(<ModuleTestList tests={[MERGES]} run={null} stale={false} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: `Delete ${MERGES.description}` }));
    fireEvent.blur(screen.getByRole("button", { name: `Confirm deleting ${MERGES.description}` }));
    expect(screen.getByRole("button", { name: `Delete ${MERGES.description}` })).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe("the coverage badge", () => {
  it("colours line coverage green from 80%, amber from 60% and red below", () => {
    expect([100, 80, 79.9, 60, 59.9, 0].map(coverageTone)).toEqual(["success", "success", "warning", "warning", "danger", "danger"]);
  });

  it("shows line coverage in its colour with branch coverage beside it", () => {
    render(<CoverageBadge run={run(64, 41.5)} testCount={2} />);
    expect(screen.getByText("64% lines")).toHaveAttribute("data-tone", "warning");
    expect(screen.getByText("41.5% branches")).toBeInTheDocument();
    expect(screen.getByLabelText("Line coverage 64%, branch coverage 41.5%")).toBeInTheDocument();
  });

  it("shows a module with no tests as red 0%", () => {
    render(<CoverageBadge run={null} testCount={0} />);
    expect(screen.getByText("0% lines")).toHaveAttribute("data-tone", "danger");
    expect(screen.getByText("0% branches")).toBeInTheDocument();
  });

  it("says coverage is not measured yet for cases that have not run", () => {
    render(<CoverageBadge run={null} testCount={2} />);
    expect(screen.getByLabelText("Coverage not measured yet")).toBeInTheDocument();
  });
});

describe("the not fully tested marker", () => {
  it("says which reason applies", () => {
    const { unmount } = render(<NotFullyTested module={{ testCount: 0, testRun: null }} />);
    expect(screen.getByRole("note", { name: "Not fully tested: no tests" })).toHaveTextContent("Not fully tested · no tests");
    unmount();

    render(<NotFullyTested module={{ testCount: 2, testRun: run(64) }} />);
    expect(screen.getByRole("note", { name: "Not fully tested: 1 failing case, 64% line coverage, under 80%" })).toBeInTheDocument();
  });

  it("is absent for a fully tested module and for a step with no module", () => {
    const passing: ModuleTestRun = { ...run(85), cases: [run(85).cases[0]!] };
    const { container } = render(
      <>
        <NotFullyTested module={{ testCount: 1, testRun: passing }} />
        <NotFullyTested module={undefined} />
      </>,
    );
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent("Not fully tested");
  });
});
