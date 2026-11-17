# Reference solar elevations for MarsSunTest: the Sun above the IAU_MARS ellipsoid normal at Jezero, from SPICE.
#   pip install spiceypy; python3 spice-sun-reference.py 2027-02-01T00:00:00 ...
import os, sys
import numpy as np
import spiceypy as sp
K = os.path.join(os.path.dirname(__file__), '../../../spice-kernels/')
for k in ['naif0012.tls','pck00011.tpc','de440s.bsp','mar097_2020_2040.bsp']: sp.furnsh(K+k)
re,_,rp = sp.bodvrd('MARS','RADII',3)[1]
def elev(utc, latc, lon):
    et = sp.str2et(utc)
    # surface point from planetocentric lat/lon on ellipsoid
    p = sp.latrec(1, np.radians(lon), np.radians(latc)); p = np.array(p)
    # scale to ellipsoid
    s = 1/np.sqrt((p[0]**2+p[1]**2)/re**2 + p[2]**2/rp**2); p = p*s
    n = sp.surfnm(re,re,rp,p)
    sun,_ = sp.spkcpo('SUN', et, 'IAU_MARS', 'OBSERVER', 'CN+S', p, 'MARS', 'IAU_MARS')
    v = sun[:3]; v = v/np.linalg.norm(v)
    return 90 - np.degrees(np.arccos(np.dot(v,n))), np.linalg.norm(sun[:3])/1.495978707e8
for utc,lat,lon in [(a, 18.4446, 77.4509) for a in sys.argv[1:]] :
    e,au = elev(utc,lat,lon)
    print(utc, round(e,4), round(au,6))
