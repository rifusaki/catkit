import numpy as np
from typing import Callable, Tuple

StepFn = Callable[
    [Callable[[float, np.ndarray], np.ndarray], float, np.ndarray, float],
    np.ndarray,
]

def integrate(
    f: Callable[[float, np.ndarray], np.ndarray],
    t_span: Tuple[float, float],
    y0: np.ndarray,
    h: float,
    step_fn: StepFn,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Generic fixed-step ODE integrator.

    Owns the loop bookkeeping (direction, step clamping, accumulation)
    and delegates the single-step update to *step_fn*. This allows for
    trivial swapping of different integration methods.

    Parameters
    f       : callable(t, y) -> ndarray             RHS of dy/dt = f(t, y)
    t_span  : (t0, tf)                              integration interval;
                                                    tf < t0 means backward integration
    y0      : array_like                            initial state at t = t0
    h       : float                                 step size magnitude (always positive)
    step_fn : callable(f, t, y, h) -> ndarray       single-step update, e.g. euler_step

    Returns
    t : ndarray, shape (N,)        grid of independent-variable values
    y : ndarray, shape (N, d)      solution; y[i] is the state at t[i]
    """
    t0, tf = t_span
    direction = 1.0 if tf >= t0 else -1.0
    h_signed = direction * abs(h)

    t_vals = [t0]
    y_vals = [np.atleast_1d(np.array(y0, dtype=float))]

    t = t0
    y = y_vals[0].copy()

    while direction * (tf - t) > 1e-12 * abs(h):
        if direction * (t + h_signed - tf) > 0:
            h_signed = tf - t

        y = step_fn(f, t, y, h_signed)
        t = t + h_signed

        t_vals.append(t)
        y_vals.append(y.copy())

    return np.array(t_vals), np.array(y_vals)

def euler_step(
    f: Callable[[float, np.ndarray], np.ndarray],
    t: float,
    y: np.ndarray,
    h: float,
) -> np.ndarray:
    """
    Classic Forward Euler update.

        y_{n+1} = y_n + h * f(t_n, y_n)

    Parameters
    f : callable(t [scalar], y [array_like]) -> array_like
        RHS of dy/dt = f(t, y)
    t : float
        current independent variable
    y : ndarray
        current state vector
    h : float
        signed step size

    Returns
    y_next : ndarray   state after one Euler step
    """
    return y + h * np.atleast_1d(f(t, y))

def rk2_midpoint_step(
    f: Callable[[float, np.ndarray], np.ndarray],
    t: float,
    y: np.ndarray,
    h: float,
) -> np.ndarray:
    """
    RK2 Midpoint method update.

        k1 = f(t,         y)
        k2 = f(t + h/2,   y + h/2 * k1)
        y_{n+1} = y + h * k2

    Parameters
    f : callable(t [scalar], y [array_like]) -> array_like
        RHS of dy/dt = f(t, y)
    t : float
        current independent variable
    y : ndarray
        current state vector
    h : float
        signed step size

    Returns
    y_next : ndarray   state after one RK2 midpoint step
    """
    k1 = np.atleast_1d(f(t, y))
    k2 = np.atleast_1d(f(t + h / 2, y + h / 2 * k1))
    return y + h * k2

def rk4_runge_step(
    f: Callable[[float, np.ndarray], np.ndarray],
    t: float,
    y: np.ndarray,
    h: float,
) -> np.ndarray:
    """
    Classic 4th-order Runge-Kutta update.

        k1 = f(t,         y)
        k2 = f(t + h/2,   y + h/2 * k1)
        k3 = f(t + h/2,   y + h/2 * k2)
        k4 = f(t + h,     y + h   * k3)
        y_{n+1} = y + h/6 * (k1 + 2*k2 + 2*k3 + k4)

    Parameters
    f : callable(t [scalar], y [array_like]) -> array_like
        RHS of dy/dt = f(t, y)
    t : float
        current independent variable
    y : ndarray
        current state vector
    h : float
        signed step size

    Returns
    y_next : ndarray   state after one RK4 step
    """
    k1 = np.atleast_1d(f(t, y))
    k2 = np.atleast_1d(f(t + h / 2, y + h / 2 * k1))
    k3 = np.atleast_1d(f(t + h / 2, y + h / 2 * k2))
    k4 = np.atleast_1d(f(t + h, y + h * k3))
    return y + (h / 6.0) * (k1 + 2 * k2 + 2 * k3 + k4)

# Alias: the notebook and most call-sites use rk4_step
rk4_step = rk4_runge_step

def rk4_kutta_step(
    f: Callable[[float, np.ndarray], np.ndarray],
    t: float,
    y: np.ndarray,
    h: float,
) -> np.ndarray:
    """
    Kutta's 3/8 rule update (4th-order Runge-Kutta variant).

        k1 = f(t,               y)
        k2 = f(t + h/3,         y + h/3 * k1)
        k3 = f(t + 2h/3,        y - h/3 * k1 + h * k2)
        k4 = f(t + h,           y + h * k1 - h * k2 + h * k3)
        y_{n+1} = y + h/8 * (k1 + 3*k2 + 3*k3 + k4)

    Parameters
    f : callable(t [scalar], y [array_like]) -> array_like
        RHS of dy/dt = f(t, y)
    t : float
        current independent variable
    y : ndarray
        current state vector
    h : float
        signed step size

    Returns
    y_next : ndarray   state after one Kutta 3/8 rule step
    """
    k1 = np.atleast_1d(f(t, y))
    k2 = np.atleast_1d(f(t + h / 3, y + h / 3 * k1))
    k3 = np.atleast_1d(f(t + 2 * h / 3, y - h / 3 * k1 + h * k2))
    k4 = np.atleast_1d(f(t + h, y + h * k1 - h * k2 + h * k3))
    return y + (h / 8.0) * (k1 + 3 * k2 + 3 * k3 + k4)
