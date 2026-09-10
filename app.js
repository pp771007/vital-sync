const { createApp, ref, computed } = Vue;
createApp({
  setup() {
    const currentTab = ref('bp');
    const bp = ref({ sys: '', dia: '', pulse: '', note: '' });
    const weight = ref({ intPart: '', decPart: '', note: '' });
    const bpLoading = ref(false);
    const weightLoading = ref(false);
    const toastMsg = ref('');
    const toastVisible = ref(false);
    const toastType = ref('info'); // 'info' | 'error' | 'loading'
    const modalVisible = ref(false);
    const historyData = ref([]);
    const bpNoteOpen = ref(false);
    const weightNoteOpen = ref(false);
    const bpInfoOpen = ref(false);
    const deletingId = ref(null);
    let touchStartX = 0;
    let toastTimer = null;

    // Weight display helper
    const weightDisplay = computed(() => {
      const i = weight.value.intPart;
      const d = weight.value.decPart;
      if (i === '' || i === null || i === undefined) return '';
      const dec = (d !== '' && d !== null && d !== undefined) ? d : '0';
      const num = parseFloat(`${i}.${dec}`);
      if (isNaN(num)) return '';
      return d && d.length === 2 ? num.toFixed(2) : num.toFixed(1);
    });

    // ── BP status & input classes ──
    const sysInputClass = computed(() => {
      const v = parseInt(bp.value.sys);
      if (!v || v < 10) return '';
      if (v >= 160) return 'warn-purple';
      if (v >= 140) return 'warn-red';
      if (v >= 120) return 'warn-amber';
      if (v < 90) return 'warn-blue';
      return '';
    });
    const diaInputClass = computed(() => {
      const v = parseInt(bp.value.dia);
      if (!v || v < 10) return '';
      if (v >= 100) return 'warn-purple';
      if (v >= 90) return 'warn-red';
      if (v >= 80) return 'warn-amber';
      if (v < 60) return 'warn-blue';
      return '';
    });
    const pulseInputClass = computed(() => {
      const v = parseInt(bp.value.pulse);
      if (!v || v < 10) return '';
      return v > 100 ? 'warn-red' : (v < 60 ? 'warn-blue' : '');
    });

    const sysStatus = computed(() => {
      const v = parseInt(bp.value.sys);
      if (!v || v < 10) return { text: '', color: '' };
      if (v >= 160) return { text: '二期', color: 'text-purple-400' };
      if (v >= 140) return { text: '一期', color: 'text-red-400' };
      if (v >= 120) return { text: '前期', color: 'text-amber-400' };
      if (v < 90) return { text: '偏低', color: 'text-blue-400' };
      return { text: '正常', color: 'text-emerald-400' };
    });
    const diaStatus = computed(() => {
      const v = parseInt(bp.value.dia);
      if (!v || v < 10) return { text: '', color: '' };
      if (v >= 100) return { text: '二期', color: 'text-purple-400' };
      if (v >= 90) return { text: '一期', color: 'text-red-400' };
      if (v >= 80) return { text: '前期', color: 'text-amber-400' };
      if (v < 60) return { text: '偏低', color: 'text-blue-400' };
      return { text: '正常', color: 'text-emerald-400' };
    });
    const pulseStatus = computed(() => {
      const v = parseInt(bp.value.pulse);
      if (!v || v < 10) return { text: '', color: '' };
      return v > 100
        ? { text: '偏快', color: 'text-red-400' }
        : (v < 60 ? { text: '偏慢', color: 'text-blue-400' } : { text: '正常', color: 'text-emerald-400' });
    });

    // ── Toast ──
    function notify(msg, type = 'info', duration = 3000) {
      if (toastTimer) clearTimeout(toastTimer);
      toastMsg.value = msg;
      toastType.value = type;
      toastVisible.value = true;
      if (duration > 0) {
        toastTimer = setTimeout(() => { toastVisible.value = false; }, duration);
      }
    }
    function hideToast() {
      if (toastTimer) clearTimeout(toastTimer);
      toastVisible.value = false;
    }

    // ── Smart jump ──
    function smartJump(e, nextId) {
      const v = e.target.value;
      const limit = ['1'].includes(v[0]) ? 3 : 2;
      if (v.length >= limit) {
        if (nextId === 'bp-note' && !bpNoteOpen.value) { document.getElementById('bp-submit')?.focus(); }
        else { document.getElementById(nextId)?.focus(); }
      }
    }

    function smartJumpWeightInt(e) {
      let v = e.target.value.replace(/\D/g, '');
      if (v.length > 3) v = v.slice(0, 3);
      weight.value.intPart = v;
      const limit = v[0] === '1' ? 3 : 2;
      if (v.length >= limit && parseInt(v) >= 10) {
        document.getElementById('weight-dec')?.focus();
      }
    }

    function smartJumpWeightDec(e) {
      let v = e.target.value.replace(/\D/g, '');
      if (v.length > 2) v = v.slice(0, 2);
      weight.value.decPart = v;
      if (v.length >= 2) {
        setTimeout(() => {
          if (weightNoteOpen.value) { document.getElementById('weight-note')?.focus(); }
          else { document.getElementById('weight-submit')?.focus(); }
        }, 0);
      }
    }

    // ② 血壓欄位 backspace 跳回上一格
    function backspaceBPDia(e) {
      if (bp.value.dia === '') {
        e.preventDefault();
        document.getElementById('sys')?.focus();
      }
    }
    function backspaceBPPulse(e) {
      if (bp.value.pulse === '') {
        e.preventDefault();
        document.getElementById('dia')?.focus();
      }
    }
    function backspaceBPNote(e) {
      if (bp.value.note === '') {
        e.preventDefault();
        document.getElementById('pulse')?.focus();
      }
    }

    // 體重欄位 backspace 跳回
    function backspaceWeightDec(e) {
      if (weight.value.decPart === '' || weight.value.decPart === null) {
        document.getElementById('weight-int')?.focus();
      }
    }
    function backspaceWeightNote(e) {
      if (weight.value.note === '') {
        e.preventDefault();
        document.getElementById('weight-dec')?.focus();
      }
    }

    function focusWeightDec() {
      document.getElementById('weight-dec')?.focus();
    }

    // ── Submit BP ──
    function submitBP() {
      if (!bp.value.sys || !bp.value.dia) return notify('⚠️ 請填寫血壓數值', 'error');
      if (parseInt(bp.value.sys) <= parseInt(bp.value.dia)) return notify('⚠️ 收縮壓應高於舒張壓', 'error');
      bpLoading.value = true;
      notify('⏳ 上傳中，請稍候…', 'loading', 0);
      addRecord('bp', bp.value).then(() => {
        bpLoading.value = false;
        hideToast();
        bp.value = { sys: '', dia: '', pulse: '', note: '' };
        bpNoteOpen.value = false;
        notify('✅ 血壓紀錄已儲存', 'info', 2500);
      }).catch((err) => {
        console.error(err);
        bpLoading.value = false;
        notify('❌ 上傳失敗，請重試', 'error', 3000);
      });
    }

    // ── Submit Weight ──
    function submitWeight() {
      if (!weight.value.intPart) return notify('⚠️ 請輸入體重', 'error');
      const val = parseFloat(`${weight.value.intPart}.${weight.value.decPart || 0}`);
      if (isNaN(val) || val < 10) return notify('⚠️ 請輸入有效體重', 'error');
      weightLoading.value = true;
      notify('⏳ 上傳中，請稍候…', 'loading', 0);
      const decLen = (weight.value.decPart || '').length;
      const displayVal = val.toFixed(decLen === 2 ? 2 : 1);
      addRecord('weight', { weight: displayVal, note: weight.value.note }).then(() => {
        weightLoading.value = false;
        hideToast();
        weight.value = { intPart: '', decPart: '', note: '' };
        weightNoteOpen.value = false;
        notify('✅ 體重紀錄已儲存', 'info', 2500);
      }).catch((err) => {
        console.error(err);
        weightLoading.value = false;
        notify('❌ 上傳失敗，請重試', 'error', 3000);
      });
    }

    function openSpreadsheet() {
      window.open(spreadsheetUrl(currentTab.value), '_blank');
    }

    // ── History ──
    function showHistory() {
      notify('🔍 讀取中...', 'loading', 0);
      getHistory(currentTab.value).then(data => {
        hideToast();
        historyData.value = data;
        modalVisible.value = true;
      }).catch((err) => {
        console.error(err);
        notify('❌ 讀取失敗，請重試', 'error', 3000);
      });
    }

    function deleteItem(id) {
      if (deletingId.value) return;
      Swal.fire({
        title: '刪除紀錄？',
        text: '刪除後將無法還原',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        confirmButtonText: '確定刪除',
        cancelButtonText: '取消',
        background: '#1e293b',
        color: '#fff'
      }).then(res => {
        if (res.isConfirmed) {
          deletingId.value = id;
          notify('⏳ 刪除中，請稍候…', 'loading', 0);
          deleteRecord(currentTab.value, id).then(() => {
            historyData.value = historyData.value.filter(i => i[0] !== id);
            deletingId.value = null;
            notify('🗑️ 刪除成功', 'info', 2500);
          }).catch((err) => {
            console.error(err);
            deletingId.value = null;
            notify('❌ 刪除失敗，請重試', 'error', 3000);
          });
        }
      });
    }

    // ── Swipe ──
    function onTouchStart(e) {
      if (modalVisible.value || bpInfoOpen.value) return;
      const tag = e.target.tagName;
      touchStartX = e.changedTouches[0].clientX;
    }
    function onTouchEnd(e) {
      if (modalVisible.value || bpInfoOpen.value) return;
      if (!touchStartX) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (dx < -70) currentTab.value = 'weight';
      else if (dx > 70) currentTab.value = 'bp';
      touchStartX = 0;
    }

    Vue.onMounted(() => {
      document.addEventListener('touchstart', onTouchStart, { passive: true });
      document.addEventListener('touchend', onTouchEnd, { passive: true });

    });

    Vue.onUnmounted(() => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchend', onTouchEnd);
    });

    // ── History colors ──
    function getSysColorClass(v) {
      v = parseInt(v);
      return v >= 160 ? 'text-purple-400' : (v >= 140 ? 'text-red-400' : (v >= 120 ? 'text-amber-400' : (v < 90 ? 'text-blue-400' : 'text-white')));
    }
    function getDiaColorClass(v) {
      v = parseInt(v);
      return v >= 100 ? 'text-purple-400' : (v >= 90 ? 'text-red-400' : (v >= 80 ? 'text-amber-400' : (v < 60 ? 'text-blue-400' : 'text-white')));
    }
    function getBPBorderClass(s, d) {
      s = parseInt(s); d = parseInt(d);
      return (s >= 160 || d >= 100) ? 'border-purple-500'
        : ((s >= 140 || d >= 90) ? 'border-red-500'
        : ((s >= 120 || d >= 80) ? 'border-amber-500'
        : ((s < 90 || d < 60) ? 'border-blue-500' : 'border-slate-700')));
    }

    return {
      currentTab, bp, weight, weightDisplay,
      bpLoading, weightLoading, toastMsg, toastVisible, toastType,
      modalVisible, historyData, bpNoteOpen, weightNoteOpen, bpInfoOpen, deletingId,
      sysInputClass, diaInputClass, pulseInputClass,
      sysStatus, diaStatus, pulseStatus,
      switchTab: t => currentTab.value = t,
      smartJump, smartJumpWeightInt, smartJumpWeightDec,
      backspaceBPDia, backspaceBPPulse, backspaceBPNote,
      backspaceWeightDec, backspaceWeightNote, focusWeightDec,
      submitBP, submitWeight, showHistory, openSpreadsheet,
      closeModal: () => modalVisible.value = false,
      deleteItem,
      getSysColorClass, getDiaColorClass, getBPBorderClass
    };
  }
}).mount('#app');
