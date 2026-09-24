import { Component, type ErrorInfo, type ReactNode } from "react";
import { firstLine } from "../../../errors.ts";
import { COPY } from "../state/index.ts";

interface ErrorBoundaryState {
  readonly why: string | undefined;
}

/**
 * If drawing the page ever throws, say so in words instead of leaving a blank screen.
 *
 * React still offers this only as a class: a boundary needs getDerivedStateFromError, which has no
 * hook. Nothing has been sent when the page fails to draw, and the message says that, because a
 * poster's first question on seeing an error near a payment is whether their money moved.
 */
export class ErrorBoundary extends Component<{ readonly children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { why: undefined };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { why: firstLine(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // kept for whoever opens the console; the poster is told in the page
    console.error("the posting page failed to draw", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.why === undefined) return this.props.children;
    return (
      <main className="sheets">
        <section className="sheet notice" role="alert">
          <p>{COPY.broken(this.state.why)}</p>
        </section>
      </main>
    );
  }
}
