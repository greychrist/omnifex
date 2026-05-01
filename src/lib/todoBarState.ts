export type TodoBarState =
  | { kind: 'collapsed_idle' }
  | { kind: 'expanded_auto' }
  | { kind: 'expanded_pinned' };

export type TodoBarAction =
  | { type: 'TODOS_CHANGED' }
  | { type: 'TIMER_EXPIRED' }
  | { type: 'CLICK' };

export const initialTodoBarState: TodoBarState = { kind: 'collapsed_idle' };

export function todoBarReducer(state: TodoBarState, action: TodoBarAction): TodoBarState {
  switch (state.kind) {
    case 'collapsed_idle': {
      if (action.type === 'TODOS_CHANGED') return { kind: 'expanded_auto' };
      if (action.type === 'CLICK') return { kind: 'expanded_pinned' };
      return state;
    }
    case 'expanded_auto': {
      if (action.type === 'TIMER_EXPIRED') return { kind: 'collapsed_idle' };
      if (action.type === 'CLICK') return { kind: 'collapsed_idle' };
      if (action.type === 'TODOS_CHANGED') return { kind: 'expanded_auto' };
      return state;
    }
    case 'expanded_pinned': {
      if (action.type === 'CLICK') return { kind: 'collapsed_idle' };
      return state;
    }
  }
}
