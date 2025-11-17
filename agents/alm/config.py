vault = {
    'wide_range': 10000, #the model supports also wide in the range 5k - 20k
    'token0': 'USDT',
    'token1': 'WBTC'
}

agent = {
    'horizon': 1000, #measured in the bot steps
    'step_timestamp': 6*60*60 #he timestamp difference between two bot steps when bot reads vault state
}

