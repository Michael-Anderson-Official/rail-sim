/* =========================================================================
   Rail Sim — 桜上水〜上北沢（京王線 実データ）ブラウザ3D 第1スライス
   ・実際の線路カーブ（OSM）を3Dで敷設
   ・桜上水を2面4線（本線±通過線＋待避線の passing loop）で表現
   ・特急が本線を通過する間、各停が待避線で待つ「待避」を再現（今回は台本制御）
   ========================================================================= */
(function () {
  'use strict';

  // 京王の車両形式（実車の帯色・塗装をもとにした低ポリ表現）。makeTrain()より先に定義する必要がある。
  // 車体はローカルZが進行方向（前面は+Z端）、幅はX、高さはY。
  var TRAIN_TYPES = {
    // 5000系：京王ライナー。銀車体に赤〜紺のラッピング、黒い前面
    KEIO_5000: { base: 0xe0e4e9, roof: 0xbabec4, front: 0x1b1f2a, name: '5000系',
      bands: [{ y: 1.35, h: 0.55, color: 0xd6006f }, { y: 0.82, h: 0.5, color: 0x16295c }], accent: 0xd6006f },
    // 8000系：ステンレス銀に京王ブルーの帯＋細い赤ライン
    KEIO_8000: { base: 0xd2d6db, roof: 0xaeb2b8, front: 0x222732, name: '8000系',
      bands: [{ y: 2.15, h: 0.5, color: 0x0e4aa0 }, { y: 2.5, h: 0.12, color: 0xe4007f }], accent: 0x0e4aa0 },
    // 7000系：ステンレス銀に青帯＋赤ライン（帯の位置を8000と少し変える）
    KEIO_7000: { base: 0xd4d8dd, roof: 0xafb3b9, front: 0x242934, name: '7000系',
      bands: [{ y: 2.2, h: 0.45, color: 0x0e4aa0 }, { y: 1.85, h: 0.12, color: 0xe4007f }], accent: 0x0e4aa0 },
    // 9000系：ステンレス銀に青＋赤帯、前面は黒い顔
    KEIO_9000: { base: 0xd8dce1, roof: 0xb2b6bc, front: 0x141821, name: '9000系',
      bands: [{ y: 2.15, h: 0.5, color: 0x0e4aa0 }, { y: 2.5, h: 0.14, color: 0xe4007f }], accent: 0x0e4aa0 },
    // 2000系：往年のライトグリーン塗装（レトロ）
    KEIO_2000: { base: 0x86b96a, roof: 0x6f9e57, front: 0x5f8a49, name: '2000系',
      bands: [{ y: 2.55, h: 0.16, color: 0xece5cc }], accent: 0xece5cc }
  };

  // ---- シーンの基本 ----
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbcd4e6);
  scene.fog = new THREE.Fog(0xbcd4e6, 600, 1400);

  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  document.getElementById('app').appendChild(renderer.domElement);

  var camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 4000);
  camera.position.set(120, 180, 320);

  var controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.49;   // 地面より下に回り込まない
  controls.minDistance = 40;
  controls.maxDistance = 900;

  // ---- ライティング ----
  var hemi = new THREE.HemisphereLight(0xffffff, 0x788c78, 0.85);
  scene.add(hemi);
  var sun = new THREE.DirectionalLight(0xfff4e0, 0.9);
  sun.position.set(-260, 380, 220);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  var sc = sun.shadow.camera;
  sc.left = -600; sc.right = 600; sc.top = 400; sc.bottom = -400; sc.near = 1; sc.far = 1200;
  scene.add(sun);

  // ---- 地面（沿線の街をほのめかす低ポリ） ----
  var ground = new THREE.Mesh(
    new THREE.PlaneGeometry(3000, 2000),
    new THREE.MeshLambertMaterial({ color: 0x9bb08a })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  scene.add(ground);
  var osmMesh = buildRealBuildings();   // OSM箱建物（PLATEAU読込完了までのつなぎ＆フォールバック）
  loadPlateau();                        // PLATEAU LOD2（実際の屋根形状の建物）を非同期で読み込む

  // ---- PLATEAU LOD2建物の読み込み（b3dm→glb化済み・Draco圧縮） ----
  function loadPlateau() {
    if (typeof PLATEAU_TILES === 'undefined' || typeof fetch === 'undefined' ||
        !THREE.GLTFLoader || !THREE.DRACOLoader) return;
    var draco = new THREE.DRACOLoader();
    draco.setDecoderPath('draco/');
    var loader = new THREE.GLTFLoader();
    loader.setDRACOLoader(draco);

    // ECEF→ローカル(ENU)変換の基底（SEGMENT.centerを原点に）
    var A = 6378137, E2 = 0.00669437999014;
    var la = SEGMENT.center.lat * Math.PI / 180, lo = SEGMENT.center.lng * Math.PI / 180;
    var Nrad = A / Math.sqrt(1 - E2 * Math.sin(la) * Math.sin(la));
    var C0 = [Nrad * Math.cos(la) * Math.cos(lo), Nrad * Math.cos(la) * Math.sin(lo), Nrad * (1 - E2) * Math.sin(la)];
    var Ev = [-Math.sin(lo), Math.cos(lo), 0];
    var Nv = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
    var Uv = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    // ecefベクトル→three(x=東, y=上, z=南)への回転行列
    var Menu = new THREE.Matrix4().set(
      Ev[0], Ev[1], Ev[2], 0,
      Uv[0], Uv[1], Uv[2], 0,
      -Nv[0], -Nv[1], -Nv[2], 0,
      0, 0, 0, 1);
    var RxB = new THREE.Matrix4().makeRotationX(Math.PI / 2);   // glTF y-up → ECEF z-up（規格どおりの向き）

    function tileMatrix(centerEcef, useRx) {
      var d = new THREE.Vector3(centerEcef[0] - C0[0], centerEcef[1] - C0[1], centerEcef[2] - C0[2]);
      d.applyMatrix4(Menu);
      var rot = new THREE.Matrix4().copy(Menu);
      if (useRx) rot.multiply(RxB);
      var m = new THREE.Matrix4().copy(rot);
      m.setPosition(d);
      return m;
    }

    var group = new THREE.Group();
    var pmat = new THREE.MeshLambertMaterial({ color: 0xded8cc, side: THREE.DoubleSide });
    var loaded = 0, failed = 0;
    // 軸の向きはDracoを実デコードして検証済み：glTF y-up → ECEF z-up の Rx(+90°) が正
    // （node側の検証で up=80..98m ＝標高＋ジオイド＋建物高と一致することを確認）
    PLATEAU_TILES.forEach(function (t) {
      fetch('plateau/' + t.f).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.arrayBuffer();
      }).then(function (ab) {
        loader.parse(ab, '', function (g) {
          var node = g.scene;
          node.traverse(function (o) {
            if (o.isMesh) {
              if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
              o.material = pmat;
              o.castShadow = false; o.receiveShadow = true;
            }
          });
          var holder = new THREE.Group();
          holder.matrixAutoUpdate = false;
          holder.matrix.copy(tileMatrix(t.c, true));
          holder.add(node);
          group.add(holder);
          done();
        }, function () { failed++; done(); });
      }).catch(function () { failed++; done(); });
    });
    function done() {
      loaded++;
      if (loaded < PLATEAU_TILES.length) return;
      if (group.children.length === 0) return;         // 全滅ならOSM箱のまま
      // 地面高さ合わせ：一番低い床がy=0に来るように全体を下げる
      group.updateMatrixWorld(true);
      var box = new THREE.Box3().setFromObject(group);
      group.position.y = -box.min.y;
      scene.add(group);
      if (osmMesh) { scene.remove(osmMesh); }          // 箱の街からPLATEAUの街へ差し替え
    }
  }

  // ---- 中心線（実カーブ）をスプライン化 ----
  // SEGMENT.points は [x(east), z(south)] のメートル。three.jsは (x, y, z)。
  var centerPts = SEGMENT.points.map(function (p) { return new THREE.Vector3(p[0], 0, p[1]); });
  var center = new THREE.CatmullRomCurve3(centerPts, false, 'catmullrom', 0.5);
  var stA = SEGMENT.stations.sakurajosui;   // 桜上水（東）
  var stB = SEGMENT.stations.kamikitazawa;  // 上北沢（西）
  var pSakura = new THREE.Vector3(stA[0], 0, stA[1]);

  // 中心線上で桜上水に一番近いパラメータ u を求める
  var uSakura = nearestU(center, pSakura);
  var uKami = nearestU(center, new THREE.Vector3(stB[0], 0, stB[1]));   // 上北沢（島式1面2線）
  var LEN = center.getLength();
  var WINDOW = 150 / LEN;                    // 待避線が枝分かれする窓（±150m）

  // 待避線のふくらみ：窓の外は本線と同じ、中央で外へ +4m（passing loop）
  function loopBump(u) {
    var d = Math.abs(u - uSakura);
    if (d > WINDOW) return 0;
    var t = 1 - d / WINDOW;                  // 端0→中央1
    return smoothstep(t) * 6.5;              // 最大6.5mふくらむ（島ホームを挟める間隔）
  }
  // 上北沢の島式ホームぶんのふくらみ：駅の前後で上下線が外へ開いて島を挟む
  var KAMI_WINDOW = 90 / LEN;
  function kamiBump(u) {
    var d = Math.abs(u - uKami);
    if (d > KAMI_WINDOW) return 0;
    var t = 1 - d / KAMI_WINDOW;
    return smoothstep(t) * 1.3;              // 最大1.3m外へ（島ホーム幅を確保）
  }

  // 横オフセット付きの線路カーブを作る（法線方向へずらす）
  function offsetCurve(baseOffsetFn) {
    var N = 240, pts = [];
    for (var i = 0; i <= N; i++) {
      var u = i / N;
      var p = center.getPointAt(u);
      var tan = center.getTangentAt(u);
      var nx = -tan.z, nz = tan.x;           // xz平面での法線
      var off = baseOffsetFn(u);
      pts.push(new THREE.Vector3(p.x + nx * off, 0, p.z + nz * off));
    }
    return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
  }

  // 4本の線路：本線±2m（上北沢では島ホームを挟んで外へ開く）、待避線は桜上水で外へふくらむ
  var GAUGE = 1.6;
  var trackUpThrough = offsetCurve(function (u) { return 2.2 + kamiBump(u); });    // 上り本線
  var trackDnThrough = offsetCurve(function (u) { return -2.2 - kamiBump(u); });   // 下り本線（通過）
  var trackUpLoop = offsetCurve(function (u) { return 2.2 + kamiBump(u) + loopBump(u); });   // 上り待避
  var trackDnLoop = offsetCurve(function (u) { return -2.2 - kamiBump(u) - loopBump(u); });  // 下り待避

  [trackUpThrough, trackDnThrough, trackUpLoop, trackDnLoop].forEach(function (c) { buildTrack(c); });

  // ---- 桜上水の駅（2面4線：島式ホーム2面＋橋上駅舎） ----
  buildStation();
  buildBridgeStationHouse();
  // ---- 上北沢の駅（島式1面2線＋小さな駅舎） ----
  buildKamikitazawa(uKami);
  addLabel('桜上水', pSakura, 0x1b3a5b);
  addLabel('上北沢', new THREE.Vector3(stB[0], 0, stB[1]), 0x1b3a5b);

  // ---- 列車 ----
  // 下り（東→西）：特急は本線を通過、各停は待避線で待つ
  var express = makeTrain('KEIO_5000', 5);  // 京王5000系（京王ライナー）＝通過の特急役・5両
  var local = makeTrain('KEIO_8000', 4);    // 京王8000系（各停）＝待避する各停・4両
  scene.add(express.group); scene.add(local.group);

  // ---- 待避のタイムライン（台本制御。本格信号は次スライスで） ----
  // 各停は uStop で停車、特急が通過してから発車する
  var uStopLoop = uSakura;                 // 各停が待避で停まる位置（中心線パラメータ基準）
  var loopLen = trackDnLoop.getLength();
  var thrLen = trackDnThrough.getLength();
  var caption = document.getElementById('caption');

  var T = 0, CYCLE = 26;
  function updateTrains(dt) {
    T = (T + dt) % CYCLE;

    // --- 各停（下り待避線）---
    // 0-8s: 進入して減速→停車、8-18s: 待避で停車、18-26s: 発車して西へ
    var locU, locStopped = false;
    if (T < 8) {
      locU = ease(T / 8) * uStopLoop;                 // 進入して停車位置へ
    } else if (T < 18) {
      locU = uStopLoop; locStopped = true;            // 待避中
    } else {
      locU = uStopLoop + ease((T - 18) / 8) * (1 - uStopLoop); // 発車して終端へ
    }
    placeTrain(local, trackDnLoop, locU);

    // --- 特急（下り本線）：各停が待避に入った頃に通過 ---
    var exU;
    if (T < 6) { express.group.visible = false; exU = 0; }
    else { express.group.visible = true; exU = ease((T - 6) / 14); }  // 6-20sで一気に通過
    if (exU > 1) exU = 1;
    placeTrain(express, trackDnThrough, exU);

    // 実況キャプション
    if (T < 8) caption.textContent = '各停、桜上水の待避線に進入…';
    else if (T < 14) caption.textContent = '各停は待避線で停車。特急が本線を通過します';
    else if (T < 18) caption.textContent = '特急、通過。';
    else caption.textContent = '各停、発車。上北沢へ。';
  }

  // ---- メインループ ----
  // ---- 前面展望（各停=8000系の運転台にカメラを置く） ----
  var viewMode = 'orbit';
  var savedCam = null;
  function setViewMode(mode) {
    viewMode = mode;
    var btn = document.getElementById('viewBtn');
    if (mode === 'cab') {
      savedCam = { pos: camera.position.clone(), target: controls.target.clone() };
      controls.enabled = false;
      if (btn) btn.textContent = '🚁 上空にもどる';
    } else {
      controls.enabled = true;
      if (savedCam) { camera.position.copy(savedCam.pos); controls.target.copy(savedCam.target); }
      if (btn) btn.textContent = '🚃 前面展望';
    }
  }
  var viewBtn = document.getElementById('viewBtn');
  if (viewBtn) viewBtn.addEventListener('click', function () { setViewMode(viewMode === 'cab' ? 'orbit' : 'cab'); });

  function updateCabCamera() {
    var t = local;                                   // 各停に乗る（待避中に特急が横を通過する）
    if (!t._curve) return;
    var L = t._curve.getLength();
    var headDist = t._uHead * L + 0.9;               // 先頭面のすぐ外＝前面ガラス位置（車体の中に入らない）
    var u = Math.max(0.001, Math.min(0.999, headDist / L));
    var p = t._curve.getPointAt(u);
    var tan = t._curve.getTangentAt(u);
    camera.position.set(p.x, 3.0, p.z);
    camera.lookAt(p.x + tan.x * 60, 2.0, p.z + tan.z * 60);
  }

  var last = performance.now(), booted = false;
  function animate(now) {
    var dt = Math.min((now - last) / 1000, 0.05); last = now;
    try {
      updateTrains(dt);
      if (viewMode === 'cab') updateCabCamera();
      else controls.update();
      renderer.render(scene, camera);
    } catch (e) {
      if (window.__boot) window.__boot('LOOP: ' + (e && e.message) + '\n' + (e && e.stack ? String(e.stack).split('\n').slice(0, 3).join('\n') : ''));
      return;   // ループを止めて原因を表示（暴走 log を防ぐ）
    }
    if (!booted) { booted = true; var be = document.getElementById('boot'); if (be) be.style.display = 'none'; }
    requestAnimationFrame(animate);
  }
  controls.target.copy(pSakura);
  requestAnimationFrame(animate);

  window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ====================== 部品づくり ======================

  // 線路：バラスト（帯）＋2本のレール＋枕木（インスタンス）
  function buildTrack(curve) {
    var N = 200;
    var pts = curve.getSpacedPoints(N);
    // バラスト帯
    var ballastGeo = ribbonGeometry(curve, N, 1.9, 0.02);
    var ballast = new THREE.Mesh(ballastGeo, new THREE.MeshLambertMaterial({ color: 0x8a8378, side: THREE.DoubleSide }));
    ballast.receiveShadow = true; scene.add(ballast);
    // レール2本
    [GAUGE / 2, -GAUGE / 2].forEach(function (off) {
      var railPts = [];
      for (var i = 0; i <= N; i++) {
        var u = i / N, p = curve.getPointAt(u), tan = curve.getTangentAt(u);
        var nx = -tan.z, nz = tan.x;
        railPts.push(new THREE.Vector3(p.x + nx * off, 0.15, p.z + nz * off));
      }
      var railCurve = new THREE.CatmullRomCurve3(railPts);
      var rail = new THREE.Mesh(
        new THREE.TubeGeometry(railCurve, N, 0.08, 6, false),
        new THREE.MeshStandardMaterial({ color: 0x5a5f66, metalness: 0.8, roughness: 0.4 })
      );
      rail.castShadow = true; scene.add(rail);
    });
    // 枕木（InstancedMesh）
    var step = 3, count = Math.floor(curve.getLength() / step);
    var tie = new THREE.InstancedMesh(
      new THREE.BoxGeometry(2.5, 0.12, 0.28),
      new THREE.MeshLambertMaterial({ color: 0x6b5842 }), count);
    var m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    for (var i = 0; i < count; i++) {
      var u = i / count, p = curve.getPointAt(u), tan = curve.getTangentAt(u);
      var ang = Math.atan2(tan.x, tan.z);
      q.setFromAxisAngle(up, ang);
      m.compose(new THREE.Vector3(p.x, 0.06, p.z), q, new THREE.Vector3(1, 1, 1));
      tie.setMatrixAt(i, m);
    }
    tie.receiveShadow = true; scene.add(tie);
  }

  // 中心カーブに沿った平らな帯（バラスト用）
  function ribbonGeometry(curve, N, halfW, y) {
    var pos = [], idx = [];
    for (var i = 0; i <= N; i++) {
      var u = i / N, p = curve.getPointAt(u), tan = curve.getTangentAt(u);
      var nx = -tan.z, nz = tan.x;
      pos.push(p.x + nx * halfW, y, p.z + nz * halfW);
      pos.push(p.x - nx * halfW, y, p.z - nz * halfW);
    }
    for (var i = 0; i < N; i++) {
      var a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
      idx.push(a, b, c, b, d, c);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  }

  // 桜上水の駅：2面の島式ホーム＋上屋
  function buildStation() {
    var pmat = new THREE.MeshLambertMaterial({ color: 0xd8d2c4, side: THREE.DoubleSide });
    var roofmat = new THREE.MeshLambertMaterial({ color: 0x3a4a5a, side: THREE.DoubleSide });
    // 島式ホームは「本線(±2.2)と待避線(±8.7)の真ん中」＝±5.45。幅は車両限界に合わせる
    [5.45, -5.45].forEach(function (side) {
      var slabPts = [];
      for (var i = 0; i <= 40; i++) {
        var u = uSakura - WINDOW * 0.55 + (WINDOW * 1.1) * (i / 40);   // 待避線が十分開いている区間だけ
        if (u < 0 || u > 1) continue;
        var p = center.getPointAt(u), tan = center.getTangentAt(u);
        var nx = -tan.z, nz = tan.x;
        // ホーム中心も膨らみに追従（本線と待避線の中点）
        var mid = side > 0 ? (2.2 + 2.2 + loopBump(u)) / 2 : -(2.2 + 2.2 + loopBump(u)) / 2;
        slabPts.push(new THREE.Vector3(p.x + nx * mid, 0, p.z + nz * mid));
      }
      if (slabPts.length < 2) return;
      var slabCurve = new THREE.CatmullRomCurve3(slabPts);
      var slab = new THREE.Mesh(ribbonRaised(slabCurve, slabPts.length * 3, 1.45, 0.9),
        pmat);
      slab.castShadow = true; slab.receiveShadow = true; scene.add(slab);
      // 上屋（薄い屋根）
      var roof = new THREE.Mesh(ribbonRaised(slabCurve, slabPts.length * 3, 1.7, 4.4), roofmat);
      scene.add(roof);
    });
  }

  // 桜上水の橋上駅舎：線路をまたぐ箱＋支柱
  function buildBridgeStationHouse() {
    var p = center.getPointAt(uSakura), tan = center.getTangentAt(uSakura);
    var g = new THREE.Group();
    g.position.set(p.x, 0, p.z);
    g.rotation.y = Math.atan2(tan.x, tan.z);
    var wall = new THREE.MeshLambertMaterial({ color: 0xe8e2d6 });
    var glass = new THREE.MeshStandardMaterial({ color: 0x9fc4d8, metalness: 0.4, roughness: 0.3 });
    var roof = new THREE.MeshLambertMaterial({ color: 0x40556a });
    var body = new THREE.Mesh(new THREE.BoxGeometry(26, 3.4, 13), wall);
    body.position.y = 8.2; body.castShadow = true; g.add(body);
    var win = new THREE.Mesh(new THREE.BoxGeometry(26.1, 1.2, 13.1), glass);
    win.position.y = 8.4; g.add(win);
    var top = new THREE.Mesh(new THREE.BoxGeometry(27.5, 0.5, 14.5), roof);
    top.position.y = 10.1; g.add(top);
    [[-11, 5], [-11, -5], [11, 5], [11, -5]].forEach(function (o) {
      var leg = new THREE.Mesh(new THREE.BoxGeometry(1.1, 6.5, 1.1), wall);
      leg.position.set(o[0], 3.25, o[1]); leg.castShadow = true; g.add(leg);
    });
    scene.add(g);
  }

  // 上北沢：島式1面2線（上下線に挟まれた島ホーム）＋構内踏切側の小さな駅舎
  function buildKamikitazawa(uK) {
    var pmat = new THREE.MeshLambertMaterial({ color: 0xd8d2c4, side: THREE.DoubleSide });
    var roofmat = new THREE.MeshLambertMaterial({ color: 0x4a5a4a, side: THREE.DoubleSide });
    var LEN2 = 45 / LEN;                         // ±45m のホーム
    // 島ホーム＝中心線上（線路は±2mなので、その内側1面）
    var pts = [];
    for (var i = 0; i <= 30; i++) {
      var u = uK - LEN2 + (LEN2 * 2) * (i / 30);
      if (u < 0 || u > 1) continue;
      pts.push(center.getPointAt(u));
    }
    if (pts.length >= 2) {
      var cv = new THREE.CatmullRomCurve3(pts);
      var slab = new THREE.Mesh(ribbonGeometry(cv, pts.length * 3, 1.7, 0.9), pmat);
      slab.castShadow = true; slab.receiveShadow = true; scene.add(slab);
      var roof = new THREE.Mesh(ribbonGeometry(cv, pts.length * 3, 1.9, 4.2), roofmat);
      scene.add(roof);
    }
    // 駅舎（ホーム端の脇に小さな箱＝駅出入口のイメージ）
    var uEnd = Math.min(1, uK + LEN2);
    var p = center.getPointAt(uEnd), tan = center.getTangentAt(uEnd);
    var nx = -tan.z, nz = tan.x;
    var house = new THREE.Group();
    house.position.set(p.x + nx * 7, 0, p.z + nz * 7);
    house.rotation.y = Math.atan2(tan.x, tan.z);
    var hw = new THREE.MeshLambertMaterial({ color: 0xefe8da });
    var hb = new THREE.Mesh(new THREE.BoxGeometry(7, 3.6, 5), hw);
    hb.position.y = 1.8; hb.castShadow = true; house.add(hb);
    var hr = new THREE.Mesh(new THREE.BoxGeometry(8, 0.4, 6), new THREE.MeshLambertMaterial({ color: 0x8a4a3a }));
    hr.position.y = 3.8; house.add(hr);
    scene.add(house);
  }

  // 高さのある帯（ホーム床/屋根）: 上面のみの板を y に置く
  function ribbonRaised(curve, N, halfW, y) {
    return (function () {
      var g = ribbonGeometry(curve, N, halfW, y);
      return g;
    })();
  }

  // 列車：形式ごとの塗装で、先頭〜後尾の車をつなぐ
  function makeTrain(typeKey, cars) {
    var t = TRAIN_TYPES[typeKey] || TRAIN_TYPES.KEIO_8000;
    var group = new THREE.Group();
    var baseMat = new THREE.MeshStandardMaterial({ color: t.base, metalness: 0.35, roughness: 0.5 });
    var roofMat = new THREE.MeshStandardMaterial({ color: t.roof, metalness: 0.3, roughness: 0.6 });
    var winMat = new THREE.MeshStandardMaterial({ color: 0x10161f, metalness: 0.6, roughness: 0.25 });
    var frontMat = new THREE.MeshStandardMaterial({ color: t.front, metalness: 0.4, roughness: 0.4 });
    var lampMat = new THREE.MeshStandardMaterial({ color: 0xfff6d6, emissive: 0x554400, emissiveIntensity: 0.5 });
    var darkMat = new THREE.MeshStandardMaterial({ color: 0x333840, metalness: 0.6, roughness: 0.4 });
    var W = 2.9, H = 3.4, CAR = 18, GAP = 2;
    var arr = [];
    for (var i = 0; i < cars; i++) {
      var c = new THREE.Group();
      // 車体
      var b = new THREE.Mesh(new THREE.BoxGeometry(W, H, CAR), baseMat); b.position.y = 2.0; b.castShadow = true; c.add(b);
      // 側面の窓帯
      var w = new THREE.Mesh(new THREE.BoxGeometry(W + 0.04, 1.0, CAR * 0.86), winMat); w.position.y = 2.55; c.add(w);
      // 形式の帯（側面の横ストライプ）
      t.bands.forEach(function (bd) {
        var band = new THREE.Mesh(new THREE.BoxGeometry(W + 0.06, bd.h, CAR * 0.99),
          new THREE.MeshStandardMaterial({ color: bd.color, metalness: 0.2, roughness: 0.5 }));
        band.position.y = bd.y; c.add(band);
      });
      // 屋根＋クーラー
      var roof = new THREE.Mesh(new THREE.BoxGeometry(W * 0.82, 0.45, CAR * 0.96), roofMat); roof.position.y = 3.75; c.add(roof);
      for (var k = 0; k < 2; k++) {
        var ac = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.35, 2.4), roofMat); ac.position.set(0, 4.05, -4.5 + k * 9); c.add(ac);
      }
      // パンタグラフ（2両目に）
      if (i === 1) {
        var pgBase = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 1.4), darkMat); pgBase.position.set(0, 4.2, 3); c.add(pgBase);
        var pgArm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.0, 0.1), darkMat); pgArm.position.set(0, 4.6, 3); pgArm.rotation.x = 0.5; c.add(pgArm);
      }
      // 先頭車の前面（+Z端）
      if (i === 0) {
        var fp = new THREE.Mesh(new THREE.BoxGeometry(W, H * 0.94, 0.5), frontMat); fp.position.set(0, 2.05, CAR / 2 + 0.1); fp.castShadow = true; c.add(fp);
        var fw = new THREE.Mesh(new THREE.BoxGeometry(W * 0.66, 1.15, 0.55), winMat); fw.position.set(0, 2.8, CAR / 2 + 0.16); c.add(fw);
        [-0.95, 0.95].forEach(function (x) {
          var lm = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.32, 0.3), lampMat); lm.position.set(x, 1.45, CAR / 2 + 0.22); c.add(lm);
        });
        // 種別・行先の光る表示（形式のアクセント色）
        var ds = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.42, 0.3),
          new THREE.MeshStandardMaterial({ color: t.accent, emissive: t.accent, emissiveIntensity: 0.35 }));
        ds.position.set(0, 3.4, CAR / 2 + 0.2); c.add(ds);
      }
      c.userData.spacing = i * (CAR + GAP);
      group.add(c); arr.push(c);
    }
    return { group: group, cars: arr, carLen: CAR + GAP, total: cars * (CAR + GAP), typeName: t.name };
  }

  // 列車をカーブ上の位置 u（先頭）に配置。各車を後ろへ並べて向きも合わせる
  function placeTrain(train, curve, uHead) {
    train._curve = curve; train._uHead = uHead;   // 前面展望カメラ用に記録
    var L = curve.getLength();
    train.cars.forEach(function (c) {
      var dist = uHead * L - c.userData.spacing - 9;   // 車体中心
      var u = Math.max(0, Math.min(1, dist / L));
      var p = curve.getPointAt(u), tan = curve.getTangentAt(u);
      c.position.set(p.x, 0, p.z);
      c.rotation.y = Math.atan2(tan.x, tan.z);
    });
  }

  // 駅名ラベル（キャンバス→スプライト。常にカメラを向く）
  function addLabel(text, pos, color) {
    var cv = document.createElement('canvas'); cv.width = 256; cv.height = 96;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(255,255,255,0.92)'; roundRect(ctx, 6, 20, 244, 56, 14); ctx.fill();
    ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
    ctx.font = 'bold 44px "Hiragino Kaku Gothic ProN", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 50);
    var tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4;
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sp.position.set(pos.x, 22, pos.z); sp.scale.set(34, 12.75, 1);
    scene.add(sp);
  }

  // 沿線の実在建物（OSMのフットプリント＋高さ）を1つのメッシュに合成して建てる
  function buildRealBuildings() {
    if (typeof BUILDINGS === 'undefined' || !BUILDINGS.length) return;
    var palette = [
      [0.85, 0.82, 0.76], [0.80, 0.76, 0.70], [0.88, 0.88, 0.88],
      [0.78, 0.72, 0.66], [0.83, 0.79, 0.72], [0.75, 0.78, 0.80]
    ];
    var pos = [], col = [];
    function pushTri(ax, ay, az, bx, by, bz, cx, cy, cz, c) {
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      for (var k = 0; k < 3; k++) col.push(c[0], c[1], c[2]);
    }
    for (var bi = 0; bi < BUILDINGS.length; bi++) {
      var b = BUILDINGS[bi], poly = b.p, h = b.h;
      var base = palette[bi % palette.length];
      var roofC = [base[0] * 0.82, base[1] * 0.82, base[2] * 0.84];
      // 壁（各辺を2三角形で）
      for (var i = 0; i < poly.length; i++) {
        var a = poly[i], c2 = poly[(i + 1) % poly.length];
        pushTri(a[0], 0, a[1], c2[0], 0, c2[1], c2[0], h, c2[1], base);
        pushTri(a[0], 0, a[1], c2[0], h, c2[1], a[0], h, a[1], base);
      }
      // 屋根（多角形を三角形分割）
      var v2 = poly.map(function (p) { return new THREE.Vector2(p[0], p[1]); });
      var tris = THREE.ShapeUtils.triangulateShape(v2, []);
      for (var t2 = 0; t2 < tris.length; t2++) {
        var i0 = tris[t2][0], i1 = tris[t2][1], i2 = tris[t2][2];
        pushTri(poly[i0][0], h, poly[i0][1], poly[i1][0], h, poly[i1][1], poly[i2][0], h, poly[i2][1], roofC);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    var mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }

  // ====================== ヘルパー ======================
  function smoothstep(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }
  function ease(t) { t = Math.max(0, Math.min(1, t)); return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function nearestU(curve, target) {
    var best = 0, bd = Infinity;
    for (var i = 0; i <= 400; i++) {
      var u = i / 400, p = curve.getPointAt(u), d = p.distanceToSquared(target);
      if (d < bd) { bd = d; best = u; }
    }
    return best;
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
})();
