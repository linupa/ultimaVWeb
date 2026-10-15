# Writes a random walk through a dungeon as a key script: enter, set the active player, light a
# torch, then N steps of walking, turning, Search, Look, Cast In Lor, Get, Open, Jimmy, Attack,
# View and camping. python3 tools/reference/dungeon-walk.py SEED N > scenarios/NAME.keys
import random, sys
random.seed(int(sys.argv[1])); n=int(sys.argv[2])
k=['45','0','0','31','0','49','0']
for i in range(n):
    r=random.random()
    if r<0.5: k+=['3','0']
    elif r<0.62: k+=['1','0']
    elif r<0.74: k+=['2','0']
    elif r<0.77: k+=['4','0']
    elif r<0.81: k+=['53','0',random.choice(['3','4','1','2']),'0']      # Search
    elif r<0.84: k+=['4c','0','3','0','4e','0']       # Look ahead (no to drinking)
    elif r<0.86: k+=['43','0','49','4c','d','0']  # cast In Lor
    elif r<0.88: k+=['47','0']              # Get
    elif r<0.90: k+=['4f','0']              # Open
    elif r<0.92: k+=['4a','0']              # Jimmy
    elif r<0.94: k+=['41','0']              # Attack
    elif r<0.95: k+=['56','0']              # View (gem)
    elif r<0.97: k+=['48','0','33','0','4e','0']  # camp 3 hours, no watch
    else: k+=['20','0']
k+=['0','0']
print(' '.join(k))
