from typing import Callable, Tuple, Optional

RootStepFn = Callable[
    [Callable[[float], float], Optional[Callable[[float], float]], tuple],
    tuple,
]

def find_root(
    f: Callable[[float], float],
    df: Optional[Callable[[float], float]],
    state0: tuple,
    step_fn: RootStepFn,
    tol: float = 1e-8,
    max_iter: int = 200,
) -> float:
    """
    Generic scalar root-finder.

    Owns the convergence loop and delegates the single-step update to
    *step_fn*. This allows for trivial swapping of different root-finding
    methods.

    State convention
    newton_step    :  state = (x,)            — 1-tuple point estimate
    bisection_step :  state = (a, b)          — 2-tuple bracket
    secant_step    :  state = (x_{n-1}, x_n)  — 2-tuple two-point window

    Convergence is declared when *either* criterion is met:
      1. |f(estimate)| < tol          (residual)
      2. |b - a|       < tol          (bracket width, bisection only)

    Parameters
    f        : callable(x) -> float   function whose root is sought
    df       : callable(x) -> float   derivative; pass None for bisection / secant
    state0   : tuple                  initial state (see convention above)
    step_fn  : callable               newton_step | bisection_step | secant_step
    tol      : float                  convergence tolerance (default 1e-8)
    max_iter : int                    iteration cap (default 200)

    Returns
    x : float   approximate root

    Raises
    RuntimeError  if max_iter is reached without convergence
    """
    state = state0
    for _ in range(max_iter):
        if len(state) == 1:
            x = state[0]
        elif len(state) == 2:
            x = state[-1] if 'secant' in step_fn.__name__ else 0.5 * (state[0] + state[1])
        else:
            x = state[-1]

        if abs(f(x)) < tol:
            return x

        if len(state) == 2 and 'bisection' in step_fn.__name__ and abs(state[1] - state[0]) < tol:
            return x

        state = step_fn(f, df, state)

    raise RuntimeError(
        f"find_root did not converge after {max_iter} iterations "
        f"(last |f(x)| = {abs(f(x)):.3e})"
    )

def newton_step(
    f: Callable[[float], float],
    df: Callable[[float], float],
    state: Tuple[float],
) -> Tuple[float]:
    """
    Newton-Raphson update  x_{n+1} = x_n - f(x_n) / f'(x_n).

    Parameters
    f     : callable(x) -> float   function whose root is sought
    df    : callable(x) -> float   derivative of f
    state : (x,)                   1-tuple holding the current estimate

    Returns
    state_next : (x_next,)   updated 1-tuple

    Raises
    ZeroDivisionError  if f'(x) == 0
    """
    x = state[0]
    dfx = df(x)
    if dfx == 0.0:
        raise ZeroDivisionError(f'Derivative is zero at x = {x}')
    return (x - f(x) / dfx,)

def bisection_step(
    f: Callable[[float], float],
    df: Optional[Callable[[float], float]],
    state: Tuple[float, float],
) -> Tuple[float, float]:
    """
    Bisection update: halve the bracket [a, b] by discarding the half
    that does not contain the sign change.

    Parameters
    f     : callable(x) -> float     function whose root is sought
    df    : ignored                  (kept for uniform step-function signature)
    state : (a, b)                   2-tuple bracket with f(a)*f(b) <= 0

    Returns
    state_next : (a', b')   halved bracket still containing the root
    """
    a, b = state
    m = 0.5 * (a + b)
    return (a, m) if f(a) * f(m) <= 0.0 else (m, b)

def secant_step(
    f: Callable[[float], float],
    df: Optional[Callable[[float], float]],
    state: Tuple[float, float],
) -> Tuple[float, float]:
    """
    Secant method update.

        x_{n+1} = x_n - f(x_n) * (x_n - x_{n-1}) / (f(x_n) - f(x_{n-1}))

    Parameters
    f     : callable(x) -> float   function whose root is sought
    df    : ignored                (kept for uniform step-function signature)
    state : (x_{n-1}, x_n)         2-tuple holding the two most recent estimates

    Returns
    state_next : (x_n, x_{n+1})   updated 2-tuple, shifting window forward

    Raises
    ZeroDivisionError  if f(x_n) == f(x_{n-1})
    """
    x_prev, x_curr = state
    f_curr = f(x_curr)
    f_prev = f(x_prev)
    if f_curr - f_prev == 0.0:
        raise ZeroDivisionError(f"Denominator is zero in secant step at x={x_curr}")
    x_next = x_curr - f_curr * (x_curr - x_prev) / (f_curr - f_prev)
    return (x_curr, x_next)
