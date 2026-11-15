#include "../src/Controller.h"
#include <stdio.h>
#include <math.h>
int main(){
  WarehouseController c(7);
  float temp=24,hum=45; int weight=17; bool wOk=true, estop=false;
  char buf[2048];
  for(int t=1;t<=1700;t++){
    if(t==300)c.setMode(WH_RUSH);
    if(t==600)c.jam();
    if(t==900)c.clearAll();
    if(t==1000)c.setMode(WH_NORMAL);
    if(t==1100)estop=true;
    if(t==1150)estop=false;
    if(t==1190||t==1390)c.clearAll();
    if(t==1200)temp=33;
    if(t==1300)c.setFault(true);
    if(t==1350)c.setFault(false);
    if(t==1400){temp=24;weight=45;}
    if(t==1500)weight=17;
    if(t==1600){wOk=false;}
    c.setInputs(weight,wOk,temp,hum,estop);c.tick();
    if(t%10==0){c.trace(buf,sizeof(buf));puts(buf);}
  }
  return 0;
}
