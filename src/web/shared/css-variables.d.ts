/**
 * Custom properties are part of the stylesheet's contract with the components: a shard says where
 * it lies (--sx, --turn) and a sheet how far it leans (--lean), and the CSS does the rest. React's
 * style type does not know about them, so this teaches it that any `--name` is allowed, rather than
 * every component casting its style object past the compiler.
 */
import "react";

declare module "react" {
  interface CSSProperties {
    [variable: `--${string}`]: string | number;
  }
}
