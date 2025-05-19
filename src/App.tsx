import './App.css';
import { useEffect, useRef, useMemo, useState } from 'react';
import { Watch } from 'touch-sdk';
import { trait, createWorld, Entity } from 'koota'; 
import { useTrait, WorldProvider, useWorld } from 'koota/react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Edges, OrthographicCamera } from '@react-three/drei'
import * as THREE from 'three';

interface Vector3 { x: number; y: number; z: number; }
interface Vector4 extends Vector3 { w: number; }
interface Vector2 { x: number; y: number; }
interface TouchScreenResolution { width: number; height: number; }
interface GestureProbDetail { [key: string]: number; }

const THROW_SPEED_SCALE = 500;
const FRICTION_FACTOR = 0.50; 
const BOUNDARY_PADDING = 100; // Added padding constant

const IsConnected = trait({ value: false });
const Hand = trait({ value: null as string | null });
const HapticsAvailable = trait({ value: null as boolean | null });
const TouchScreenRes = trait({ value: null as TouchScreenResolution | null });
const BatteryPercentage = trait({ value: null as number | null });
const LastTapTime = trait({ value: null as Date | null });
const GestureProb = trait({ value: null as GestureProbDetail | null });
const ArmDirection = trait({ value: null as Vector2 | null });
const Acceleration = trait({ value: null as Vector3 | null });
const AngularVelocity = trait({ value: null as Vector3 | null });
const GravityVector = trait({ value: null as Vector3 | null });
const Orientation = trait({ value: null as Vector4 | null });
const TouchPosition = trait({ value: null as Vector2 | null });
const LastTouchEvent = trait({ value: null as string | null });
const RotaryStep = trait({ value: null as number | null });
const LastButtonPressTime = trait({ value: null as Date | null });

const MousePosition = trait({ x: 0, y: 0 });
const MouseVelocity = trait({ x: 0, y: 0 });
const IsThrown = trait({ value: false });

export const world = createWorld();

function WatchManager({ watchEntity }: { watchEntity: Entity }) {
  const sdkWatch = useMemo(() => new Watch(), []); 
  const connectButtonContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (connectButtonContainerRef.current) {
      while (connectButtonContainerRef.current.firstChild) {
        connectButtonContainerRef.current.removeChild(connectButtonContainerRef.current.firstChild);
      }
      const connectButton = sdkWatch.createConnectButton();
      if (connectButton && connectButtonContainerRef.current) {
        connectButtonContainerRef.current.appendChild(connectButton);
      }
    }

    const handleConnected = () => {
      watchEntity.set(IsConnected, { value: true });
      watchEntity.set(Hand, { value: sdkWatch.hand });
      watchEntity.set(HapticsAvailable, { value: sdkWatch.hapticsAvailable });
      watchEntity.set(TouchScreenRes, { value: sdkWatch.touchScreenResolution });
      watchEntity.set(BatteryPercentage, { value: sdkWatch.batteryPercentage });
    };

    const tapListener = () => {
      watchEntity.set(LastTapTime, { value: new Date() });
      
      const isThrownTrait = watchEntity.get(IsThrown);
      const currentIsThrown = isThrownTrait ? isThrownTrait.value : false;

      const armDirectionTrait = watchEntity.get(ArmDirection);
      const armDirectionValue = armDirectionTrait ? armDirectionTrait.value : null;

      if (!currentIsThrown) {
        if (armDirectionValue) {
          const initialVelocity = {
            x: armDirectionValue.x * THROW_SPEED_SCALE,
            y: armDirectionValue.y * THROW_SPEED_SCALE, 
          };
          console.log('[TapListener] Attempting to THROW. Arm Dir:', armDirectionValue, 'Initial Velocity:', initialVelocity, 'Current IsThrown:', currentIsThrown);
          watchEntity.set(MouseVelocity, initialVelocity);
          watchEntity.set(IsThrown, { value: true });
        } else {
          console.log('[TapListener] Attempting to THROW, but currentArmDir is null or undefined. Current IsThrown:', currentIsThrown);
        }
      } else {
        console.log('[TapListener] Attempting to CATCH. Current IsThrown:', currentIsThrown);
        watchEntity.set(MouseVelocity, { x: 0, y: 0 });
        watchEntity.set(IsThrown, { value: false });
      }
    };

    const probabilityListener = (event: CustomEvent) => { watchEntity.set(GestureProb, { value: event.detail }); };
    const armDirectionListener = (event: CustomEvent) => {
      const { dx, dy } = event.detail;
      watchEntity.set(ArmDirection, { value: { x: dx, y: dy } });
    };
    const accelerationListener = (event: CustomEvent) => { watchEntity.set(Acceleration, { value: event.detail }); };
    const angularVelocityListener = (event: CustomEvent) => { watchEntity.set(AngularVelocity, { value: event.detail }); };
    const gravityVectorListener = (event: CustomEvent) => { watchEntity.set(GravityVector, { value: event.detail }); };
    const orientationListener = (event: CustomEvent) => { watchEntity.set(Orientation, { value: event.detail }); };
    const touchStartListener = (event: CustomEvent) => { watchEntity.set(TouchPosition, { value: event.detail }); watchEntity.set(LastTouchEvent, { value: 'touchstart' }); };
    const touchMoveListener = (event: CustomEvent) => { watchEntity.set(TouchPosition, { value: event.detail }); watchEntity.set(LastTouchEvent, { value: 'touchmove' }); };
    const touchEndListener = (event: CustomEvent) => { watchEntity.set(TouchPosition, { value: event.detail }); watchEntity.set(LastTouchEvent, { value: 'touchend' }); };
    const touchCancelListener = (event: CustomEvent) => { watchEntity.set(TouchPosition, { value: event.detail }); watchEntity.set(LastTouchEvent, { value: 'touchcancel' }); };
    const rotaryListener = (event: CustomEvent) => { watchEntity.set(RotaryStep, { value: event.detail.step }); };
    const buttonListener = () => { watchEntity.set(LastButtonPressTime, { value: new Date() }); };

    sdkWatch.addEventListener('connected', handleConnected);
    sdkWatch.addEventListener('tap', tapListener);
    sdkWatch.addEventListener('probability', probabilityListener as EventListener);
    sdkWatch.addEventListener('armdirectionchanged', armDirectionListener as EventListener);
    sdkWatch.addEventListener('accelerationchanged', accelerationListener as EventListener);
    sdkWatch.addEventListener('angularvelocitychanged', angularVelocityListener as EventListener);
    sdkWatch.addEventListener('gravityvectorchanged', gravityVectorListener as EventListener);
    sdkWatch.addEventListener('orientationchanged', orientationListener as EventListener);
    sdkWatch.addEventListener('touchstart', touchStartListener as EventListener);
    sdkWatch.addEventListener('touchmove', touchMoveListener as EventListener);
    sdkWatch.addEventListener('touchend', touchEndListener as EventListener);
    sdkWatch.addEventListener('touchcancel', touchCancelListener as EventListener);
    sdkWatch.addEventListener('rotary', rotaryListener as EventListener);
    sdkWatch.addEventListener('button', buttonListener);

    return () => {
      sdkWatch.removeEventListener('connected', handleConnected);
      sdkWatch.removeEventListener('tap', tapListener);
      sdkWatch.removeEventListener('probability', probabilityListener as EventListener);
      sdkWatch.removeEventListener('armdirectionchanged', armDirectionListener as EventListener);
      sdkWatch.removeEventListener('accelerationchanged', accelerationListener as EventListener);
      sdkWatch.removeEventListener('angularvelocitychanged', angularVelocityListener as EventListener);
      sdkWatch.removeEventListener('gravityvectorchanged', gravityVectorListener as EventListener);
      sdkWatch.removeEventListener('orientationchanged', orientationListener as EventListener);
      sdkWatch.removeEventListener('touchstart', touchStartListener as EventListener);
      sdkWatch.removeEventListener('touchmove', touchMoveListener as EventListener);
      sdkWatch.removeEventListener('touchend', touchEndListener as EventListener);
      sdkWatch.removeEventListener('touchcancel', touchCancelListener as EventListener);
      sdkWatch.removeEventListener('rotary', rotaryListener as EventListener);
      sdkWatch.removeEventListener('button', buttonListener);
    };
  }, [sdkWatch, watchEntity]);

  const isConnectedValue = useTrait(watchEntity, IsConnected)?.value;
  const hapticsAvailableValue = useTrait(watchEntity, HapticsAvailable)?.value;

  const triggerHaptics = () => {
    if (sdkWatch && isConnectedValue && hapticsAvailableValue) {
      sdkWatch.triggerHaptics(0.7, 100);
    } else {
      globalThis.alert('Haptics not available or watch not connected.');
    }
  };

  return (
    <>
      <div ref={connectButtonContainerRef} style={{ marginBottom: '20px' }}></div>
      <button type="button" onClick={triggerHaptics} disabled={!hapticsAvailableValue || !isConnectedValue} style={{ marginTop: '10px' }}>Trigger Haptics</button>
    </>
  );
}

function R3FMouseCursor({ entity }: { entity: Entity }) {
  const meshRef = useRef<THREE.Mesh>(null!);

  useFrame((_, delta) => {
    if (!meshRef.current || !entity) {
      console.log('[R3FMouseCursor] Missing refs or Koota, skipping frame.');
      return;
    }

    const kootaPosition = entity.get(MousePosition);
    const kootaVelocity = entity.get(MouseVelocity);
    const isThrownState = entity.get(IsThrown);

    if (!kootaPosition || !kootaVelocity || !isThrownState) {
      console.log('[R3FMouseCursor] Missing Koota data, skipping frame.');
      return;
    }
    //console.log('[R3FMouseCursor] Frame Start - Koota Pos:', kootaPosition, 'Vel:', kootaVelocity, 'IsThrown:', isThrownState.value);

    let newKootaX = kootaPosition.x;
    let newKootaY = kootaPosition.y;
    let newKootaVelX = kootaVelocity.x;
    let newKootaVelY = kootaVelocity.y;

    if (isThrownState.value) {
      //console.log(`[R3FMouseCursor] THROWN: Delta: ${delta.toFixed(4)}, Vel: (${newKootaVelX.toFixed(2)}, ${newKootaVelY.toFixed(2)})`);
      newKootaX += newKootaVelX * delta;
      newKootaY += newKootaVelY * delta;

      newKootaVelX *= (1 - FRICTION_FACTOR * delta); 
      newKootaVelY *= (1 - FRICTION_FACTOR * delta);

      // Stop if velocity is negligible
      if (Math.abs(newKootaVelX) < 0.01 && Math.abs(newKootaVelY) < 0.01) {
        //console.log('[R3FMouseCursor] Velocity negligible, stopping throw.');
        entity.set(IsThrown, { value: false });
        newKootaVelX = 0;
        newKootaVelY = 0;
      }

      // Boundary checks - with padding
      if (newKootaX < BOUNDARY_PADDING) { 
        newKootaX = BOUNDARY_PADDING; 
        newKootaVelX = 0; 
        //console.log('[R3FMouseCursor] Boundary Hit: Left'); 
      }
      if (newKootaX > globalThis.innerWidth - BOUNDARY_PADDING) { 
        newKootaX = globalThis.innerWidth - BOUNDARY_PADDING; 
        newKootaVelX = 0; 
        //console.log('[R3FMouseCursor] Boundary Hit: Right'); 
      }
      if (newKootaY < BOUNDARY_PADDING) { 
        newKootaY = BOUNDARY_PADDING; 
        newKootaVelY = 0; 
        //console.log('[R3FMouseCursor] Boundary Hit: Top'); 
      }
      if (newKootaY > globalThis.innerHeight - BOUNDARY_PADDING) { 
        newKootaY = globalThis.innerHeight - BOUNDARY_PADDING; 
        newKootaVelY = 0; 
        //console.log('[R3FMouseCursor] Boundary Hit: Bottom'); 
      }

      entity.set(MousePosition, { x: newKootaX, y: newKootaY });
      entity.set(MouseVelocity, { x: newKootaVelX, y: newKootaVelY });
    }
    meshRef.current.position.x = newKootaX - globalThis.innerWidth / 2;
    meshRef.current.position.y = -(newKootaY - globalThis.innerHeight / 2);
    //console.log('[R3FMouseCursor] Frame End - Mesh Pos X:', meshRef.current.position.x, 'Y:', meshRef.current.position.y);
  });

  const initialKootaPos = entity.get(MousePosition);
  const initialMeshX = initialKootaPos ? initialKootaPos.x - globalThis.innerWidth / 2 : 0;
  const initialMeshY = initialKootaPos ? -(initialKootaPos.y - globalThis.innerHeight / 2) : 0;

  return (
    <mesh ref={meshRef} position={[initialMeshX, initialMeshY, 0]}>
      <circleGeometry args={[30, 32]} /> 
      <meshBasicMaterial color="red" />
    </mesh>
  );
}

export function VirtualMouse({ entity }: { entity: Entity }) {
  const [screenSize, setScreenSize] = useState({ width: globalThis.innerWidth, height: globalThis.innerHeight });

  useEffect(() => {
    const handleResize = () => {
      const newWidth = globalThis.innerWidth;
      const newHeight = globalThis.innerHeight;
      setScreenSize({ width: newWidth, height: newHeight });

      // Recenter mouse Koota position if it's not currently thrown
      if (entity) {
        const isThrownState = entity.get(IsThrown);
        // Ensure isThrownState exists and its value is false
        if (isThrownState && !isThrownState.value) { 
          entity.set(MousePosition, { x: newWidth / 2, y: newHeight / 2 });
          // Optionally, ensure velocity is also zero if it was caught but had residual velocity somehow
          // entity.set(MouseVelocity, { x: 0, y: 0 }); 
        }
      }
    };
    globalThis.addEventListener('resize', handleResize);
    // Call handleResize once initially to set correct initial size and position if needed
    // handleResize(); // Consider if this is needed or if initial spawn position is sufficient
    return () => globalThis.removeEventListener('resize', handleResize);
  }, [entity]); // Added entity to the dependency array
  

  return (
    <Canvas 
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: 9999
      }}
    >
      <OrthographicCamera 
        makeDefault
        left={-screenSize.width}
        right={screenSize.width}
        top={screenSize.height}
        bottom={-screenSize.height}
        near={1}
        far={1000} 
        position={[0, 0, 10]} 
      />
      <ambientLight intensity={0.5} />
      <pointLight position={[10, 10, 10]} />

      entity && <R3FMouseCursor entity={entity} />
      {/* Visual Boundary Box */}
      <mesh>
        <boxGeometry args={[screenSize.width - BOUNDARY_PADDING, screenSize.height - BOUNDARY_PADDING, 0]} /> {/* 20px padding on each side, box depth 0 */}
        <meshBasicMaterial opacity={0} transparent />
        <Edges color="cyan" lineWidth={10} />
      </mesh>

    </Canvas>
  );
}

function WatchInfoDisplay({ watchEntity }: { watchEntity: Entity }) {
  const isConnected = useTrait(watchEntity, IsConnected)?.value;
  const hand = useTrait(watchEntity, Hand)?.value;
  const hapticsAvailable = useTrait(watchEntity, HapticsAvailable)?.value;
  const touchScreenResolution = useTrait(watchEntity, TouchScreenRes)?.value;
  const batteryPercentage = useTrait(watchEntity, BatteryPercentage)?.value;
  const lastTap = useTrait(watchEntity, LastTapTime)?.value;
  const gestureProbability = useTrait(watchEntity, GestureProb)?.value;
  const armDirection = useTrait(watchEntity, ArmDirection)?.value;
  const acceleration = useTrait(watchEntity, Acceleration)?.value;
  const angularVelocity = useTrait(watchEntity, AngularVelocity)?.value;
  const gravityVector = useTrait(watchEntity, GravityVector)?.value;
  const orientation = useTrait(watchEntity, Orientation)?.value;
  const lastTouchEvent = useTrait(watchEntity, LastTouchEvent)?.value;
  const touchPosition = useTrait(watchEntity, TouchPosition)?.value;
  const rotaryStep = useTrait(watchEntity, RotaryStep)?.value;
  const lastButtonPress = useTrait(watchEntity, LastButtonPressTime)?.value;

  return (
    <div className="card">
      <div>Status: {isConnected ? 'Connected' : 'Disconnected'}</div>
      {isConnected && (
        <>
          <div>Hand: {hand ?? 'N/A'}</div>
          <div>Haptics Available: {typeof hapticsAvailable === 'boolean' ? hapticsAvailable.toString() : 'N/A'}</div>
          <div>Touch Screen: {touchScreenResolution ? `${touchScreenResolution.width}x${touchScreenResolution.height}` : 'N/A'}</div>
          <div>Battery: {batteryPercentage === null ? 'N/A' : `${batteryPercentage}%`}</div>
        </>
      )}
      <h3>Events Data:</h3>
      <div>Last Tap: {lastTap ? lastTap.toLocaleTimeString() : 'N/A'}</div>
      <div>Gesture Probability: {gestureProbability ? JSON.stringify(gestureProbability) : 'N/A'}</div>
      <div>Arm Direction: {armDirection ? `x: ${armDirection.x.toFixed(2)}, y: ${armDirection.y.toFixed(2)}` : 'N/A'}</div>
      <div>Acceleration: {acceleration ? `x: ${acceleration.x.toFixed(2)}, y: ${acceleration.y.toFixed(2)}, z: ${acceleration.z.toFixed(2)}` : 'N/A'}</div>
      <div>Angular Velocity: {angularVelocity ? `x: ${angularVelocity.x.toFixed(2)}, y: ${angularVelocity.y.toFixed(2)}, z: ${angularVelocity.z.toFixed(2)}` : 'N/A'}</div>
      <div>Gravity Vector: {gravityVector ? `x: ${gravityVector.x.toFixed(2)}, y: ${gravityVector.y.toFixed(2)}, z: ${gravityVector.z.toFixed(2)}` : 'N/A'}</div>
      <div>Orientation: {orientation ? `x: ${orientation.x.toFixed(2)}, y: ${orientation.y.toFixed(2)}, z: ${orientation.z.toFixed(2)}, w: ${orientation.w.toFixed(2)}` : 'N/A'}</div>
      <div>Last Touch Event: {lastTouchEvent ?? 'N/A'} {touchPosition ? `(x: ${touchPosition.x}, y: ${touchPosition.y})` : ''}</div>
      <div>Rotary Step: {rotaryStep === null ? 'N/A' : rotaryStep}</div>
      <div>Last Button Press: {lastButtonPress ? lastButtonPress.toLocaleTimeString() : 'N/A'}</div>
    </div>
  );
}

function AppContent() {
  const worldInstance = useWorld();

  const watchEntity = useMemo(() => {
    const existing = worldInstance.query(IsConnected, Hand, MousePosition); 
    if (existing.length > 0) return existing[0];
    
    return worldInstance.spawn(
      IsConnected, Hand, HapticsAvailable, TouchScreenRes, BatteryPercentage,
      LastTapTime, GestureProb, ArmDirection, Acceleration, AngularVelocity,
      GravityVector, Orientation, TouchPosition, LastTouchEvent, RotaryStep, LastButtonPressTime,
      MousePosition({ x: globalThis.innerWidth / 2, y: globalThis.innerHeight / 2 }), 
      MouseVelocity, 
      IsThrown 
    );
  }, [worldInstance]);

  return (
    <>
      <WatchManager watchEntity={watchEntity} />
      <VirtualMouse entity={watchEntity} /> 
      <h2>Touch SDK Watch Info</h2>
      <WatchInfoDisplay watchEntity={watchEntity} />
    </>
  );
}

function App() {
  return (
    <WorldProvider world={world}>
      <AppContent />
    </WorldProvider>
  );
}

export default App;
