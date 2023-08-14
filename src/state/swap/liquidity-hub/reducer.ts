import { createReducer } from '@reduxjs/toolkit';
import { setLiquidityHubState } from './actions';

export interface LiquidityHubState {
  liquidityHubTrade: boolean;
  isLoading: boolean;
  isFailed?: boolean;
  amountOut?: string;
}

const initialState = {
  liquidityHubTrade: false,
  isLoading: false,
  isFailed: false,
};

export default createReducer<LiquidityHubState>(initialState, (builder) =>
  builder.addCase(setLiquidityHubState, (state, { payload }) => {
    return { ...state, ...payload };
  }),
);
