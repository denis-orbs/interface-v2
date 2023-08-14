import { useAppSelector } from 'state/hooks';
import { AppState, useAppDispatch } from 'state';
import { setLiquidityHubState } from './actions';
import { LiquidityHubState } from './reducer';
import { useCallback } from 'react';

export function useLiquidityHubState(): AppState['liquidityHub'] {
  return useAppSelector((state) => {
    return state.liquidityHub;
  });
}

export const useLiquidityHubActionHandlers = () => {
  const dispatch = useAppDispatch();

  const onSetLiquidityHubState = useCallback(
    (payload: Partial<LiquidityHubState>) => {
      dispatch(setLiquidityHubState(payload));
    },
    [dispatch],
  );

  return {
    onSetLiquidityHubState,
  };
};
